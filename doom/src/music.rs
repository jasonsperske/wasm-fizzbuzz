// WebAssembly-friendly General MIDI playback for DOOM's MUS lumps.
//
// Pipeline: MUS bytes → MIDI bytes → rustysynth's MidiFileSequencer → PCM
//
// JS fetches a SoundFont2 file and hands the bytes to `mus_init`.  DOOM's
// i_sound.c calls `mus_register_song` / `mus_play_song` / etc., and an
// AudioWorklet-like ScriptProcessorNode in JS pumps `mus_render` every
// buffer to fill the output stream.

use std::io::Cursor;
use std::os::raw::{c_int, c_uint};
use std::sync::Mutex;

use rustysynth::{MidiFile, MidiFileSequencer, SoundFont, Synthesizer, SynthesizerSettings};

// ── Global state ──────────────────────────────────────────────────────────
//
// Songs and the synth live in *separate* globals on purpose: DOOM registers
// the title-screen song before the SoundFont has finished downloading, and we
// don't want that registration to fail.  Any `mus_play_song` issued before
// the synth exists is stashed in PENDING and auto-played once `mus_init`
// installs the synth.

struct MusicState {
    #[allow(dead_code)]
    sound_font: std::sync::Arc<SoundFont>,
    sequencer: MidiFileSequencer,
}

lazy_static! {
    static ref STATE: Mutex<Option<MusicState>> = Mutex::new(None);
    // Song registry lives independently of the synth state.  1-based handles.
    static ref SONGS: Mutex<Vec<Option<std::sync::Arc<MidiFile>>>> = Mutex::new(Vec::new());
    // Play issued before the synth was initialised.  Consumed by mus_init.
    static ref PENDING: Mutex<Option<(u32, bool)>> = Mutex::new(None);
    // Buffers allocated by `mus_alloc` live here, keyed by pointer value.
    // Keeps them alive and non-moving across WASM memory growth.
    static ref BUFFERS: Mutex<std::collections::HashMap<u32, Vec<u8>>> =
        Mutex::new(std::collections::HashMap::new());
}

/// Allocate `size` bytes of WASM-visible memory owned by Rust.
/// Returned pointer is stable until `mus_free` is called.
#[no_mangle]
pub extern "C" fn mus_alloc(size: c_uint) -> *mut u8 {
    let mut v = vec![0u8; size as usize];
    let p = v.as_mut_ptr();
    BUFFERS.lock().unwrap().insert(p as u32, v);
    p
}

#[no_mangle]
pub extern "C" fn mus_free(ptr: *mut u8) {
    BUFFERS.lock().unwrap().remove(&(ptr as u32));
}

// ── WASM exports ──────────────────────────────────────────────────────────

/// Initialise the synth with SoundFont2 bytes.  Returns 1 on success, 0 on
/// failure.  Safe to call again (re-initialises).  The actual `sequencer.play`
/// for any pending song is deferred to the very first `mus_render` call so it
/// happens after the AudioContext is definitely running (the ScriptProcessor
/// only pulls once the context resumes, and rustysynth's internal state is
/// more reliable if `play` is closely followed by the first `render`).
#[no_mangle]
pub extern "C" fn mus_init(sf_ptr: *const u8, sf_len: c_uint, sample_rate: c_int) -> c_int {
    if sf_ptr.is_null() || sf_len == 0 || sample_rate <= 0 {
        return 0;
    }
    let sf_bytes = unsafe { std::slice::from_raw_parts(sf_ptr, sf_len as usize) };
    let sound_font = match SoundFont::new(&mut Cursor::new(sf_bytes)) {
        Ok(sf) => std::sync::Arc::new(sf),
        Err(e) => {
            crate::log!("[music] bad soundfont: {:?}", e);
            return 0;
        }
    };
    let settings = SynthesizerSettings::new(sample_rate);
    let synth = match Synthesizer::new(&sound_font, &settings) {
        Ok(s) => s,
        Err(e) => {
            crate::log!("[music] synth init failed: {:?}", e);
            return 0;
        }
    };
    let sequencer = MidiFileSequencer::new(synth);
    *STATE.lock().unwrap() = Some(MusicState { sound_font, sequencer });
    1
}

/// Register a MUS lump; returns an opaque handle (> 0) or 0 on failure.
/// Works regardless of whether the synth is up yet.
#[no_mangle]
pub extern "C" fn mus_register_song(mus_ptr: *const u8, mus_len: c_uint) -> c_int {
    if mus_ptr.is_null() || mus_len < 16 {
        return 0;
    }
    let mus = unsafe { std::slice::from_raw_parts(mus_ptr, mus_len as usize) };

    let midi_bytes = match mus_to_midi(mus) {
        Some(b) => b,
        None => {
            crate::log!("[music] mus_to_midi failed (len={})", mus.len());
            return 0;
        }
    };
    let midi_file = match MidiFile::new(&mut Cursor::new(&midi_bytes[..])) {
        Ok(m) => std::sync::Arc::new(m),
        Err(e) => {
            crate::log!("[music] MIDI parse failed: {:?}", e);
            return 0;
        }
    };

    let mut songs = SONGS.lock().unwrap();
    songs.push(Some(midi_file));
    songs.len() as c_int // 1-based handle
}

/// Begin playback.  If the synth is not yet initialised, the request is
/// parked in PENDING and will be honoured once `mus_init` installs the synth.
#[no_mangle]
pub extern "C" fn mus_play_song(handle: c_int, looping: c_int) {
    if handle <= 0 { return; }
    let midi = {
        let songs = SONGS.lock().unwrap();
        match songs.get((handle as usize) - 1).and_then(|m| m.clone()) {
            Some(m) => m,
            None => return,
        }
    };
    match STATE.lock().unwrap().as_mut() {
        Some(state) => state.sequencer.play(&midi, looping != 0),
        None => {
            *PENDING.lock().unwrap() = Some((handle as u32, looping != 0));
        }
    }
}

/// Stop any currently playing song.
#[no_mangle]
pub extern "C" fn mus_stop_song(_handle: c_int) {
    *PENDING.lock().unwrap() = None;
    if let Some(state) = STATE.lock().unwrap().as_mut() {
        state.sequencer.stop();
    }
}

#[no_mangle]
pub extern "C" fn mus_pause_song(_handle: c_int) {
    // rustysynth's sequencer has no native pause; stopping is close enough
    // for DOOM's use (pause is rarely user-triggered).
    mus_stop_song(_handle);
}

#[no_mangle]
pub extern "C" fn mus_unregister_song(handle: c_int) {
    if handle <= 0 { return; }
    if let Some(slot) = SONGS.lock().unwrap().get_mut((handle as usize) - 1) {
        *slot = None;
    }
    let mut pending = PENDING.lock().unwrap();
    if pending.map(|(h, _)| h as i32) == Some(handle) {
        *pending = None;
    }
}

/// Fill two planar float32 buffers with `num_samples` stereo samples.
/// `left_ptr` and `right_ptr` each point to `num_samples` contiguous f32
/// slots in WASM linear memory.  Writes silence if the synth is not yet
/// initialised.
///
/// The first render after `mus_init` also consumes any PENDING song: this
/// defers `sequencer.play` to the point where the AudioContext is actually
/// running, which avoids the "synth state set while context suspended"
/// failure mode.
#[no_mangle]
pub extern "C" fn mus_render(left_ptr: *mut f32, right_ptr: *mut f32, num_samples: c_uint) {
    if num_samples == 0 || left_ptr.is_null() || right_ptr.is_null() {
        return;
    }
    let n = num_samples as usize;
    let left  = unsafe { std::slice::from_raw_parts_mut(left_ptr,  n) };
    let right = unsafe { std::slice::from_raw_parts_mut(right_ptr, n) };

    let mut guard = STATE.lock().unwrap();
    match guard.as_mut() {
        Some(state) => {
            // Drain any pending play (scheduled before the synth existed).
            let pending = PENDING.lock().unwrap().take();
            if let Some((handle, looping)) = pending {
                let midi = SONGS.lock().unwrap()
                    .get((handle as usize).saturating_sub(1))
                    .and_then(|m| m.clone());
                if let Some(midi) = midi {
                    state.sequencer.play(&midi, looping);
                }
            }
            state.sequencer.render(left, right);
        }
        None => {
            for s in left.iter_mut()  { *s = 0.0; }
            for s in right.iter_mut() { *s = 0.0; }
        }
    }
}

/// Set master music volume, 0.0 – 1.0.  (Implemented JS-side on the music
/// bus gain; kept as an export for future use.)
#[no_mangle]
pub extern "C" fn mus_set_volume(_volume: f32) {
    // no-op: JS applies music volume on the mus bus gain node
}

// ── MUS → MIDI conversion ─────────────────────────────────────────────────
//
// MUS is a compact MIDI-ish format used by DOOM.  Reference:
//   https://www.doomworld.com/forum/topic/31490-mus-file-format/
//
// Every event byte: bit 7 = delay-follows, bits 6-4 = event type,
// bits 3-0 = channel.  MUS channel 15 is percussion; all others pass through.

fn write_vlq(buf: &mut Vec<u8>, mut val: u32) {
    // Write a MIDI variable-length quantity (big-endian, high bit = continues)
    let mut bytes = [0u8; 5];
    let mut n = 0;
    bytes[n] = (val & 0x7F) as u8; n += 1;
    val >>= 7;
    while val > 0 {
        bytes[n] = ((val & 0x7F) | 0x80) as u8;
        n += 1;
        val >>= 7;
    }
    for i in (0..n).rev() {
        buf.push(bytes[i]);
    }
}

fn mus_to_midi(mus: &[u8]) -> Option<Vec<u8>> {
    if mus.len() < 16 || &mus[0..4] != b"MUS\x1a" {
        return None;
    }
    let scorelen   = u16::from_le_bytes([mus[4], mus[5]]) as usize;
    let scorestart = u16::from_le_bytes([mus[6], mus[7]]) as usize;
    if scorestart + scorelen > mus.len() {
        return None;
    }

    let mut midi: Vec<u8> = Vec::with_capacity(scorelen * 2 + 64);

    // ── MThd chunk ────────────────────────────────────────────────────────
    midi.extend_from_slice(b"MThd");
    midi.extend_from_slice(&6u32.to_be_bytes());   // chunk length
    midi.extend_from_slice(&0u16.to_be_bytes());   // format 0 (single track)
    midi.extend_from_slice(&1u16.to_be_bytes());   // 1 track
    midi.extend_from_slice(&140u16.to_be_bytes()); // 140 PPQN

    // ── MTrk chunk header (size patched after body is written) ────────────
    midi.extend_from_slice(b"MTrk");
    let size_pos = midi.len();
    midi.extend_from_slice(&0u32.to_be_bytes());
    let body_start = midi.len();

    // Tempo: 1 000 000 µs / quarter note (= 60 BPM).  Combined with 140 PPQN
    // this gives exactly 140 MIDI ticks per real-time second — matching MUS.
    midi.extend_from_slice(&[0x00, 0xFF, 0x51, 0x03, 0x0F, 0x42, 0x40]);

    let mut p = scorestart;
    let score_end = scorestart + scorelen;
    let mut delta: u32 = 0;
    let mut last_velocity = [100u8; 16];

    while p < score_end {
        let b    = mus[p]; p += 1;
        let last = (b >> 7) & 1;
        let ev   = (b >> 4) & 7;
        let mch  = b & 0x0F;
        // MUS channel 15 is the percussion channel → MIDI channel 9
        let midi_ch = if mch == 15 { 9 } else { mch };

        match ev {
            0 => {
                // NOTE_OFF
                if p >= score_end { return None; }
                let note = mus[p] & 0x7F; p += 1;
                write_vlq(&mut midi, delta);
                midi.push(0x80 | midi_ch);
                midi.push(note);
                midi.push(0x40);
                delta = 0;
            }
            1 => {
                // NOTE_ON
                if p >= score_end { return None; }
                let kb   = mus[p]; p += 1;
                let note = kb & 0x7F;
                let vel  = if kb & 0x80 != 0 {
                    if p >= score_end { return None; }
                    let v = mus[p] & 0x7F; p += 1;
                    last_velocity[mch as usize] = v;
                    v
                } else {
                    last_velocity[mch as usize]
                };
                write_vlq(&mut midi, delta);
                midi.push(0x90 | midi_ch);
                midi.push(note);
                midi.push(vel.max(1)); // MIDI vel=0 is note-off, avoid that
                delta = 0;
            }
            2 => {
                // PITCH_BEND: MUS 0..255 (128 centre) → MIDI 14-bit centre 0x2000
                if p >= score_end { return None; }
                let mb = mus[p] as i32; p += 1;
                let midi_bend = (mb * 64).clamp(0, 0x3FFF) as u32;
                write_vlq(&mut midi, delta);
                midi.push(0xE0 | midi_ch);
                midi.push((midi_bend & 0x7F) as u8);
                midi.push(((midi_bend >> 7) & 0x7F) as u8);
                delta = 0;
            }
            3 => {
                // SYSTEM_EVENT: mapped to MIDI channel-mode messages
                if p >= score_end { return None; }
                let ctrl = mus[p]; p += 1;
                let cc = match ctrl {
                    10 => Some((120, 0)), // All sounds off
                    11 => Some((123, 0)), // All notes off
                    14 => Some((121, 0)), // Reset all controllers
                    _  => None,
                };
                if let Some((c, v)) = cc {
                    write_vlq(&mut midi, delta);
                    midi.push(0xB0 | midi_ch);
                    midi.push(c);
                    midi.push(v);
                    delta = 0;
                }
            }
            4 => {
                // CONTROLLER change
                if p + 1 >= score_end { return None; }
                let ctrl = mus[p]; p += 1;
                let val  = mus[p] & 0x7F; p += 1;
                write_vlq(&mut midi, delta);
                match ctrl {
                    0 => {
                        // Program change
                        midi.push(0xC0 | midi_ch);
                        midi.push(val);
                    }
                    1 => { midi.push(0xB0 | midi_ch); midi.push(0);  midi.push(val); } // bank
                    2 => { midi.push(0xB0 | midi_ch); midi.push(1);  midi.push(val); } // mod
                    3 => { midi.push(0xB0 | midi_ch); midi.push(7);  midi.push(val); } // volume
                    4 => { midi.push(0xB0 | midi_ch); midi.push(10); midi.push(val); } // pan
                    5 => { midi.push(0xB0 | midi_ch); midi.push(11); midi.push(val); } // expr
                    6 => { midi.push(0xB0 | midi_ch); midi.push(91); midi.push(val); } // reverb
                    7 => { midi.push(0xB0 | midi_ch); midi.push(93); midi.push(val); } // chorus
                    8 => { midi.push(0xB0 | midi_ch); midi.push(64); midi.push(val); } // sustain
                    9 => { midi.push(0xB0 | midi_ch); midi.push(67); midi.push(val); } // soft
                    _ => {
                        // Unknown — rewind the meta byte we just wrote
                        midi.truncate(midi.len().saturating_sub(1));
                    }
                }
                delta = 0;
            }
            5 => { /* END_OF_MEASURE – ignored */ }
            6 => break, // SCORE_END
            _ => {}
        }

        if last != 0 {
            // Variable-length delay (MUS VLQ: big-endian, high bit = continue)
            let mut d: u32 = 0;
            loop {
                if p >= score_end { return None; }
                let db = mus[p]; p += 1;
                d = d * 128 + (db & 0x7F) as u32;
                if db & 0x80 == 0 { break; }
            }
            delta += d;
        }
    }

    // End-of-track meta event
    write_vlq(&mut midi, delta);
    midi.extend_from_slice(&[0xFF, 0x2F, 0x00]);

    // Patch MTrk size
    let body_len = (midi.len() - body_start) as u32;
    midi[size_pos..size_pos + 4].copy_from_slice(&body_len.to_be_bytes());

    Some(midi)
}
