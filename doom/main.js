'use strict';
var memory = new WebAssembly.Memory({ initial: 108 });

function readWasmString(offset, length) {
    const bytes = new Uint8Array(memory.buffer, offset, length);
    return new TextDecoder('utf8').decode(bytes);
}

// Read a null-terminated C string from WASM linear memory.
function readCString(ptr) {
    const bytes = new Uint8Array(memory.buffer, ptr);
    let len = 0;
    while (bytes[len] !== 0) len++;
    return new TextDecoder('utf8').decode(new Uint8Array(memory.buffer, ptr, len));
}

function appendOutput(style) {
    return function (offset, length) {
        // uncomment to see engine output
        // const lines = readWasmString(offset, length).split('\n');
        // for (var i = 0; i < lines.length; ++i) {
        //     if (lines[i].length == 0) {
        //         continue;
        //     }
        //     console.log(lines[i]);
        // }
    }
}


/*doom is rendered here*/
const canvas = document.getElementById('screen');
const doom_screen_width = 320 * 2;
const doom_screen_height = 200 * 2;

function drawCanvas(ptr) {
    var doom_screen = new Uint8ClampedArray(memory.buffer, ptr, doom_screen_width * doom_screen_height * 4)
    var render_screen = new ImageData(doom_screen, doom_screen_width, doom_screen_height)
    var ctx = canvas.getContext('2d');

    ctx.putImageData(render_screen, 0, 0);
}

/*These functions will be available in WebAssembly. We also share the memory to share larger amounts of data with javascript, e.g. strings of the video output.*/
var importObject = {
    js: {
        js_console_log: appendOutput("log"),
        js_stdout: appendOutput("stdout"),
        js_stderr: appendOutput("stderr"),
        js_milliseconds_since_start: () => performance.now(),
        js_draw_screen: drawCanvas,
    },
    env: {
        memory: memory,
        // C externs compile to "env" module imports in wasm32, not "js"
        js_start_sound,
        js_stop_sound,
        js_sound_is_playing,
        js_update_sound,
        js_register_song,
        js_play_song,
        js_pause_song,
        js_resume_song,
        js_stop_song,
        js_unregister_song,
        js_doom_quit: () => {
            _doomRunning = false;
            document.dispatchEvent(new CustomEvent('doomQuit'));
        },
        js_doom_error: (ptr) => {
            _doomRunning = false;
            const msg = readCString(ptr);
            console.error('[doom] I_Error:', msg);
            document.dispatchEvent(new CustomEvent('doomError', { detail: { message: msg } }));
            throw new Error('[doom] I_Error: ' + msg);
        },
        js_save_config: (ptr, len) => {
            const str = new TextDecoder('utf8').decode(new Uint8Array(memory.buffer, ptr, len));
            localStorage.setItem('doom_config', str);
        },
        js_load_config: (ptr, maxlen) => {
            const saved = localStorage.getItem('doom_config');
            if (!saved) return 0;
            const encoded = new TextEncoder().encode(saved);
            const count = Math.min(encoded.length, maxlen - 1);
            new Uint8Array(memory.buffer, ptr, count).set(encoded.subarray(0, count));
            return count;
        },
        js_level_loaded: (episode, map) => {
            window._lastLevelLoaded = { episode, map };
            // C has already cleared the watcher list for the new level.
            // Re-register every linedef that JS still has callbacks for.
            linedefListeners.forEach((_, idx) => _doomExports.watch_linedef(idx));
            // Snapshot the pristine sector heights and side textures so
            // saveState() can emit only what has changed during play.
            _captureLevelBaseline();
            document.dispatchEvent(new CustomEvent('levelLoaded', { detail: { episode, map } }));
        },
        js_linedef_used: (linedefIdx, side) => {
            const listeners = useListeners.get(linedefIdx);
            if (!listeners || listeners.size === 0) return;
            _doomExports.get_linedef_textures(linedefIdx, side);
            const info = {
                linedef: linedefIdx,
                side,
                topTexture: readCString(_doomExports.laser_top_texture()),
                midTexture: readCString(_doomExports.laser_mid_texture()),
                botTexture: readCString(_doomExports.laser_bot_texture()),
            };
            listeners.forEach(cb => cb(info));
        },
        js_linedef_crossed: (linedefIdx, fromSide) => {

            const listeners = linedefListeners.get(linedefIdx);
            if (!listeners || listeners.size === 0) return;
            // Populate the shared texture buffers for this linedef/side.
            _doomExports.get_linedef_textures(linedefIdx, fromSide);
            const info = {
                linedef: linedefIdx,
                fromSide,
                topTexture: readCString(_doomExports.laser_top_texture()),
                midTexture: readCString(_doomExports.laser_mid_texture()),
                botTexture: readCString(_doomExports.laser_bot_texture()),
            };
            listeners.forEach(cb => cb(info));
        },
    }
};

/*Write argv strings into the last 2KB of WASM memory, safely above DOOM's heap.
  Returns { argc, argvPtr } ready to pass to exports.doom_start().*/
function setupArgv(args) {
    const encoder = new TextEncoder();
    const u8 = new Uint8Array(memory.buffer);
    const view = new DataView(memory.buffer);

    let offset = memory.buffer.byteLength - 2048;
    const ptrs = [];

    for (const arg of args) {
        ptrs.push(offset);
        const encoded = encoder.encode(arg);
        u8.set(encoded, offset);
        offset += encoded.length;
        u8[offset++] = 0; // null terminator
    }

    // Align to 4 bytes for the argv pointer array
    offset = (offset + 3) & ~3;
    const argvPtr = offset;

    for (const ptr of ptrs) {
        view.setUint32(offset, ptr, true); // little-endian
        offset += 4;
    }
    view.setUint32(offset, 0, true); // null-terminate argv

    return { argc: args.length, argvPtr };
}

// ── Web Audio ─────────────────────────────────────────────────────────────
//
// Architecture:
//   SFX source → sfxGain → panner → masterGain → focusGain → destination
//   MUS events  → oscillators    → masterGain → focusGain → destination
//
// focusGain is 1.0 when the window has focus, 0.25 when it doesn't.
// masterGain mirrors DOOM's snd_SfxVolume / snd_MusicVolume.

let audioCtx = null;
let focusGain = null;   // focus/blur attenuation node
let sfxBus = null;      // receives all SFX gain nodes
let musBus = null;      // receives all music nodes

// Lazily created on first user interaction (browser autoplay policy).
function ensureAudio() {
    if (audioCtx) return true;
    try {
        audioCtx = new AudioContext();
        // Start at full volume; updateFocusGain() will attenuate if actually blurred.
        focusGain = audioCtx.createGain();
        focusGain.gain.value = 1.0;
        focusGain.connect(audioCtx.destination);

        sfxBus = audioCtx.createGain();
        sfxBus.gain.value = 1.0;
        sfxBus.connect(focusGain);

        // Music bus: dynamics compressor prevents clipping when many notes play at once
        //   musBus → musComp → focusGain → destination
        musBus = audioCtx.createGain();
        musBus.gain.value = 0.9;
        const musComp = audioCtx.createDynamicsCompressor();
        musComp.threshold.value = -18;
        musComp.knee.value      = 6;
        musComp.ratio.value     = 6;
        musComp.attack.value    = 0.003;
        musComp.release.value   = 0.15;
        musBus.connect(musComp);
        musComp.connect(focusGain);

        // Try to resume, but swallow the promise rejection if the page
        // hasn't had a user gesture yet — the document-wide gesture
        // listeners below will retry on the next real interaction.
        if (audioCtx.state === 'suspended') {
            audioCtx.resume().catch(() => {});
        }

        // Apply the correct gain for current focus state now that the node exists
        updateFocusGain();
        // Decide the real music engine now that audioCtx exists: insecure
        // origins hide `audioWorklet`, which would otherwise blow up later.
        _resolveMusEngine();
        return true;
    } catch (e) {
        console.warn('[doom] Web Audio unavailable:', e);
        return false;
    }
}

// Single source of truth for the focus gain.  Uses both document visibility
// (tab switching) and document.hasFocus() (window focus), erring on the side
// of "has focus" so background browser chrome / DevTools don't silence audio.
function updateFocusGain() {
    if (!focusGain || !audioCtx) return;
    const hasFocus = !document.hidden && document.hasFocus();
    const target   = hasFocus ? 1.0 : 0.25;
    focusGain.gain.setTargetAtTime(target, audioCtx.currentTime, 0.05);
}

window.addEventListener('focus',           updateFocusGain);
window.addEventListener('blur',            updateFocusGain);
document.addEventListener('visibilitychange', updateFocusGain);

// Some browsers (notably Chrome) keep AudioContext.currentTime advancing even
// while the context is suspended.  Any events scheduled before the first user
// gesture end up "in the past" once resume() runs.  Grab every user gesture we
// can and resume aggressively so playback starts immediately.
function resumeAudioIfSuspended() {
    if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume().catch(() => {});
    }
}
['mousedown', 'keydown', 'touchstart', 'click'].forEach(ev => {
    document.addEventListener(ev, resumeAudioIfSuspended, true);
});

// ── SFX ───────────────────────────────────────────────────────────────────
// DOOM WAD sound lump layout (little-endian):
//   0: uint16  format     (must be 3)
//   2: uint16  sampleRate (Hz, usually 11025)
//   4: uint32  numSamples
//   8: uint8[] samples    (8-bit unsigned PCM, 128 = silence)

let nextSfxHandle = 1;
const sfxChannels = new Map(); // handle → { source, gainNode, panNode, playing }

function js_start_sound(dataPtr, dataLen, vol, sep, pitch) {
    if (!ensureAudio() || dataLen < 8) return 0;
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const raw = new Uint8Array(memory.buffer, dataPtr, dataLen);
    const format     = raw[0] | (raw[1] << 8);
    const sampleRate = raw[2] | (raw[3] << 8);
    const numSamples = raw[4] | (raw[5] << 8) | (raw[6] << 16) | (raw[7] << 24);

    if (format !== 3 || sampleRate < 1) return 0;

    const offset  = 8;
    const samples = Math.min(numSamples, dataLen - offset);
    if (samples <= 0) return 0;

    const buf = audioCtx.createBuffer(1, samples, sampleRate);
    const ch  = buf.getChannelData(0);
    for (let i = 0; i < samples; i++) {
        ch[i] = (raw[offset + i] - 128) / 128.0;
    }

    const source  = audioCtx.createBufferSource();
    source.buffer = buf;
    if (pitch !== 128) {
        // DOOM pitch: 0–255, 128 = normal.  Each 64 steps ≈ one octave.
        source.playbackRate.value = Math.pow(2, (pitch - 128) / 64.0);
    }

    const gainNode = audioCtx.createGain();
    gainNode.gain.value = Math.max(0, Math.min(1, vol / 15.0));

    const panNode = audioCtx.createStereoPanner();
    panNode.pan.value = Math.max(-1, Math.min(1, (sep - 128) / 128.0));

    source.connect(gainNode);
    gainNode.connect(panNode);
    panNode.connect(sfxBus);

    const handle = nextSfxHandle++;
    const entry  = { source, gainNode, panNode, playing: true };
    sfxChannels.set(handle, entry);
    source.onended = () => { entry.playing = false; };
    source.start();
    return handle;
}

function js_stop_sound(handle) {
    const entry = sfxChannels.get(handle);
    if (entry && entry.playing) {
        try { entry.source.stop(); } catch (_) {}
        entry.playing = false;
    }
    sfxChannels.delete(handle);
}

function js_sound_is_playing(handle) {
    const entry = sfxChannels.get(handle);
    return (entry && entry.playing) ? 1 : 0;
}

function js_update_sound(handle, vol, sep, pitch) {
    const entry = sfxChannels.get(handle);
    if (!entry || !entry.playing) return;
    entry.gainNode.gain.value = Math.max(0, Math.min(1, vol / 15.0));
    entry.panNode.pan.value   = Math.max(-1, Math.min(1, (sep - 128) / 128.0));
    if (pitch !== 128) {
        entry.source.playbackRate.value = Math.pow(2, (pitch - 128) / 64.0);
    }
}

// ── Music (MUS format via rustysynth) ─────────────────────────────────────
//
// The Rust side (src/music.rs) converts MUS → MIDI and feeds it to
// rustysynth, a pure-Rust General MIDI synthesizer.  Two render paths are
// supported so we can A/B compare the legacy and the modern Web Audio APIs:
//
//   engine = 'worklet'        (default)
//     A second doom.wasm instance lives inside an AudioWorkletProcessor
//     (mus_worklet.js).  All mus_* calls are forwarded via port.postMessage,
//     and rendering happens on the audio thread.  No main-thread cost per
//     audio buffer.
//
//   engine = 'scriptprocessor'  (?engine=scriptprocessor)
//     The deprecated ScriptProcessorNode pulls PCM blocks from the main-thread
//     WASM instance.  Kept for performance comparison against the worklet.
//
// Graph (both paths): <renderer> → musBus → compressor → focusGain → destination

// `let` because we may downgrade to 'scriptprocessor' at runtime if the
// AudioContext doesn't expose `audioWorklet` (which happens whenever the page
// is served over an insecure context — plain HTTP on anything other than
// localhost/127.0.0.1 / file://, etc).
let MUS_ENGINE = new URLSearchParams(location.search).get('engine') === 'scriptprocessor'
    ? 'scriptprocessor' : 'worklet';

// Shared stats surface.  The active engine fills this in; index.html reads it.
const musStats = {
    engine: MUS_ENGINE,
    count: 0,
    sumMs: 0,
    maxMs: 0,
    lastMs: 0,
    blockSize: 0,
    sampleRate: 0,
    uptimeMs: 0,
};
window._musStats = musStats;

// ── ScriptProcessor path (legacy) ─────────────────────────────────────────
const MUS_BLOCK_SIZE = 1024;   // samples per channel per render call
let musScriptNode = null;
let musLeftPtr = 0, musRightPtr = 0;  // reserved buffers in WASM memory
let musInitialized = false;
let _musStatsStart = 0;

function initMusicSynth() {
    if (musInitialized) return Promise.resolve(true);
    if (!_doomExports || !audioCtx) return Promise.resolve(false);
    return fetch('/doom/soundfont.sf2')
        .then(r => {
            if (!r.ok) throw new Error('soundfont.sf2 not found at /doom/soundfont.sf2');
            return r.arrayBuffer();
        })
        .then(buf => {
            const bytes = new Uint8Array(buf);
            const sfPtr = _doomExports.mus_alloc(bytes.length);
            if (!sfPtr) throw new Error('WASM alloc for soundfont failed');
            new Uint8Array(memory.buffer, sfPtr, bytes.length).set(bytes);
            const ok = _doomExports.mus_init(sfPtr, bytes.length, audioCtx.sampleRate | 0);
            _doomExports.mus_free(sfPtr);
            if (!ok) throw new Error('mus_init returned 0');
            musLeftPtr  = _doomExports.mus_alloc(MUS_BLOCK_SIZE * 4);
            musRightPtr = _doomExports.mus_alloc(MUS_BLOCK_SIZE * 4);
            _setupMusScriptNode();
            musInitialized = true;
            return true;
        })
        .catch(err => {
            console.warn('[doom] music synth init failed:', err.message);
            return false;
        });
}

function _setupMusScriptNode() {
    if (musScriptNode || !audioCtx) return;
    musScriptNode = audioCtx.createScriptProcessor(MUS_BLOCK_SIZE, 0, 2);
    musStats.blockSize = MUS_BLOCK_SIZE;
    musStats.sampleRate = audioCtx.sampleRate;
    _musStatsStart = performance.now();
    musScriptNode.onaudioprocess = (ev) => {
        if (!_doomExports || !musLeftPtr || !musRightPtr) return;
        const t0 = performance.now();
        _doomExports.mus_render(musLeftPtr, musRightPtr, MUS_BLOCK_SIZE);
        const outL = ev.outputBuffer.getChannelData(0);
        const outR = ev.outputBuffer.getChannelData(1);
        outL.set(new Float32Array(memory.buffer, musLeftPtr,  MUS_BLOCK_SIZE));
        outR.set(new Float32Array(memory.buffer, musRightPtr, MUS_BLOCK_SIZE));
        const dt = performance.now() - t0;
        musStats.count++;
        musStats.sumMs += dt;
        if (dt > musStats.maxMs) musStats.maxMs = dt;
        musStats.lastMs = dt;
        musStats.uptimeMs = performance.now() - _musStatsStart;
    };
    musScriptNode.connect(musBus);
}

// ── AudioWorklet path (default) ───────────────────────────────────────────
let musWorkletNode = null;
let musWorkletReady = false;
let musWorkletInitStarted = false;
let _nextSongHandle = 1;

// DOOM's i_sound calls js_register_song / js_play_song immediately when the
// title music loads — that can easily beat `initMusicWorklet`'s async
// addModule + fetch + node construction.  Any message posted before the node
// exists is queued here and flushed once it does.
const _musPending = [];
function _postToMusWorklet(msg, transfer) {
    if (musWorkletNode) {
        musWorkletNode.port.postMessage(msg, transfer || []);
    } else {
        _musPending.push({ msg, transfer: transfer || [] });
    }
}
function _flushMusPending() {
    if (!musWorkletNode) return;
    while (_musPending.length) {
        const { msg, transfer } = _musPending.shift();
        musWorkletNode.port.postMessage(msg, transfer);
    }
}

// Check audioCtx support for AudioWorklet; downgrade MUS_ENGINE if it's
// unavailable.  Runs synchronously right after ensureAudio() creates the
// context, so js_register_song / js_play_song always see the final engine.
function _resolveMusEngine() {
    if (MUS_ENGINE !== 'worklet') return;
    if (!audioCtx) return;
    if (!audioCtx.audioWorklet) {
        console.warn('[doom] AudioWorklet unavailable (insecure context? — serve over https:// or localhost). Falling back to ScriptProcessor.');
        MUS_ENGINE = 'scriptprocessor';
        musStats.engine = 'scriptprocessor';
    }
}

async function initMusicWorklet() {
    if (musWorkletInitStarted) return;
    if (!audioCtx) return;
    _resolveMusEngine();
    if (MUS_ENGINE !== 'worklet') return;
    musWorkletInitStarted = true;
    try {
        await audioCtx.audioWorklet.addModule('/doom/mus_worklet.js');
        const [wasmRes, sfRes] = await Promise.all([
            fetch('/doom/doom.wasm'),
            fetch('/doom/soundfont.sf2'),
        ]);
        if (!wasmRes.ok) throw new Error('doom.wasm fetch failed');
        if (!sfRes.ok)   throw new Error('soundfont.sf2 fetch failed');
        const [wasmBuf, sfBuf] = await Promise.all([wasmRes.arrayBuffer(), sfRes.arrayBuffer()]);

        musWorkletNode = new AudioWorkletNode(audioCtx, 'mus-synth', {
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [2],
        });
        musWorkletNode.onprocessorerror = (ev) => {
            console.error('[doom] mus-synth processorerror:',
                ev.message, ev.filename + ':' + ev.lineno, ev.error && ev.error.stack);
        };
        musWorkletNode.port.onmessage = (ev) => {
            const m = ev.data;
            if (m.type === 'ready') {
                musWorkletReady = true;
            } else if (m.type === 'stats') {
                musStats.count      = m.count;
                musStats.sumMs      = m.sumMs;
                musStats.maxMs      = m.maxMs;
                musStats.lastMs     = m.lastMs;
                musStats.blockSize  = m.blockSize;
                musStats.sampleRate = m.sampleRate;
                musStats.uptimeMs   = m.uptimeMs;
            } else if (m.type === 'error') {
                console.error('[doom] music worklet error:', m.message);
            }
        };
        musWorkletNode.port.postMessage({
            type: 'init',
            wasmBytes: wasmBuf,
            sfBytes: sfBuf,
            sampleRate: audioCtx.sampleRate | 0,
        }, [wasmBuf, sfBuf]);
        musWorkletNode.connect(musBus);
        // Deliver anything DOOM posted during the async spin-up.
        _flushMusPending();
    } catch (err) {
        console.warn('[doom] music worklet init failed:', err.message);
        musWorkletInitStarted = false;
    }
}

// ── Public MUS API (DOOM i_sound.c → js_*_song → Rust mus_*) ──────────────
//
// Dispatch based on MUS_ENGINE.  The scriptprocessor path forwards calls
// directly into the main-thread WASM's mus_* exports; the worklet path posts
// messages to the AudioWorkletProcessor, which owns its own WASM instance.

function js_register_song(dataPtr, dataLen) {
    if (!dataLen) return 0;
    if (MUS_ENGINE === 'scriptprocessor') {
        if (!_doomExports) return 0;
        if (!musInitialized) initMusicSynth();
        return _doomExports.mus_register_song(dataPtr, dataLen);
    }
    // Worklet path: copy MUS bytes out of DOOM's wasm memory and ship across.
    ensureAudio();
    if (!musWorkletInitStarted) initMusicWorklet();
    const handle = _nextSongHandle++;
    // Copy (not view) because memory.buffer may be detached later by grow.
    const copy = new Uint8Array(dataLen);
    copy.set(new Uint8Array(memory.buffer, dataPtr, dataLen));
    _postToMusWorklet(
        { type: 'register', handle, musBytes: copy.buffer },
        [copy.buffer],
    );
    return handle;
}

function js_play_song(handle, looping) {
    if (MUS_ENGINE === 'scriptprocessor') {
        if (!_doomExports) return;
        ensureAudio();
        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
        if (!musInitialized) initMusicSynth();
        _doomExports.mus_play_song(handle, looping ? 1 : 0);
        return;
    }
    ensureAudio();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    if (!musWorkletInitStarted) initMusicWorklet();
    _postToMusWorklet({ type: 'play', handle, looping: !!looping });
}

function js_pause_song(handle) {
    if (MUS_ENGINE === 'scriptprocessor') {
        if (_doomExports) _doomExports.mus_pause_song(handle);
        return;
    }
    _postToMusWorklet({ type: 'pause', handle });
}

function js_resume_song(handle) {
    // rustysynth sequencer has no native pause, so "resume" just plays again.
    js_play_song(handle, 1);
}

function js_stop_song(handle) {
    if (MUS_ENGINE === 'scriptprocessor') {
        if (_doomExports) _doomExports.mus_stop_song(handle);
        return;
    }
    _postToMusWorklet({ type: 'stop', handle });
}

function js_unregister_song(handle) {
    if (MUS_ENGINE === 'scriptprocessor') {
        if (_doomExports) _doomExports.mus_unregister_song(handle);
        return;
    }
    _postToMusWorklet({ type: 'unregister', handle });
}


// ── Shared state ──────────────────────────────────────────────────────────
// Shared state needed by importObject.env handlers before obj is available.
const linedefListeners = new Map(); // linedefIdx → Set<callback>  (crossing)
const useListeners = new Map(); // linedefIdx → Set<callback>  (use/activate)
let _doomExports = null;            // set once WASM is instantiated
let _doomRunning = true;            // cleared by js_doom_quit to stop the loop

// Baseline level geometry captured at load time.  Used by saveState() to
// emit only the sectors / sides that have changed during play, and by
// setState() as the "reset" target before applying the snapshot's deltas.
// Shape: { sectorHeights: Int32Array(2N), sideTextures: Int32Array(3M) }
let _levelBaseline = null;

function _captureLevelBaseline() {
    if (!_doomExports) return;
    const n = _doomExports.get_num_sectors();
    const m = _doomExports.get_num_sides();
    const sh = new Int32Array(n * 2);
    for (let i = 0; i < n; i++) {
        sh[i * 2]     = _doomExports.get_sector_floor(i);
        sh[i * 2 + 1] = _doomExports.get_sector_ceiling(i);
    }
    const st = new Int32Array(m * 3);
    for (let i = 0; i < m; i++) {
        st[i * 3]     = _doomExports.get_side_top(i);
        st[i * 3 + 1] = _doomExports.get_side_mid(i);
        st[i * 3 + 2] = _doomExports.get_side_bot(i);
    }
    _levelBaseline = { sectorHeights: sh, sideTextures: st };
}

WebAssembly.instantiateStreaming(fetch('/doom/doom.wasm'), importObject)
    .then(obj => {
        _doomExports = obj.instance.exports;

        /*Launch DOOM with the given extra arguments (e.g. ["-warp", "1", "9"]).
          argv[0] is always "doom". Call this once on startup.*/
        window._doomLaunch = function (extraArgs) {
            const args = ["doom", ...extraArgs];
            const { argc, argvPtr } = setupArgv(args);

            if (typeof obj.instance.exports.doom_start !== 'function') {
                console.error('[doom] doom_start not found in exports! Available:', Object.keys(obj.instance.exports));
                return;
            }

            // Warm up the AudioContext on the first user gesture so that sound
            // is ready as soon as DOOM starts playing SFX.
            ensureAudio();
            // Kick off soundfont fetch + synth init in the background.  Any
            // js_play_song call that arrives before this resolves will be
            // queued and fired once the synth is ready.
            if (MUS_ENGINE === 'worklet') {
                initMusicWorklet();
            } else {
                initMusicSynth();
            }

            /*Initialize Doom*/
            obj.instance.exports.doom_start(argc, argvPtr);

            /*input handling*/
            let doomKeyCode = function (keyCode) {
                // Doom seems to use mostly the same keycodes, except for the following (maybe I'm missing a few.)
                switch (keyCode) {
                    case 8:
                        return 127; // KEY_BACKSPACE
                    case 17:
                        return (0x80 + 0x1d); // KEY_RCTRL
                    case 18:
                        return (0x80 + 0x38); // KEY_RALT
                    case 37:
                        return 0xac; // KEY_LEFTARROW
                    case 38:
                        return 0xad; // KEY_UPARROW
                    case 39:
                        return 0xae; // KEY_RIGHTARROW
                    case 40:
                        return 0xaf; // KEY_DOWNARROW
                    default:
                        if (keyCode >= 65 /*A*/ && keyCode <= 90 /*Z*/) {
                            return keyCode + 32; // ASCII to lower case
                        }
                        if (keyCode >= 112 /*F1*/ && keyCode <= 123 /*F12*/) {
                            return keyCode + 75; // KEY_F1
                        }
                        return keyCode;
                }
            };
            let keyDown = function (keyCode) { obj.instance.exports.add_browser_event(0 /*KeyDown*/, keyCode); };
            let keyUp = function (keyCode) { obj.instance.exports.add_browser_event(1 /*KeyUp*/, keyCode); };

            /*keyboard input*/
            canvas.addEventListener('keydown', function (event) {
                keyDown(doomKeyCode(event.keyCode));
                event.preventDefault();
            }, false);
            canvas.addEventListener('keyup', function (event) {
                keyUp(doomKeyCode(event.keyCode));
                event.preventDefault();
            }, false);

            /*mobile touch input*/
            [["enterButton", 13],
            ["leftButton", 0xac],
            ["rightButton", 0xae],
            ["upButton", 0xad],
            ["downButton", 0xaf],
            ["ctrlButton", 0x80 + 0x1d],
            ["spaceButton", 32],
            ["altButton", 0x80 + 0x38]].forEach(([elementID, keyCode]) => {
                var button = document.getElementById(elementID);
                //button.addEventListener("click", () => {keyDown(keyCode); keyUp(keyCode)} );
                button.addEventListener("touchstart", () => keyDown(keyCode));
                button.addEventListener("touchend", () => keyUp(keyCode));
                button.addEventListener("touchcancel", () => keyUp(keyCode));
            });

            /*hint that the canvas should have focus to capture keyboard events*/
            const focushint = document.getElementById("focushint");
            const printFocusInHint = function (e) {
                focushint.innerText = "Keyboard events will be captured as long as the DOOM canvas has focus.";
                focushint.style.fontWeight = "normal";
            };
            canvas.addEventListener('focusin', printFocusInHint, false);

            canvas.addEventListener('focusout', function (e) {
                focushint.innerText = "Click on the canvas to capture input and start playing.";
                focushint.style.fontWeight = "bold";
            }, false);

            canvas.focus();
            printFocusInHint();

            /*Main game loop*/
            function step(timestamp) {
                obj.instance.exports.doom_loop_step();
                obj.instance.exports.check_linedef_crossings();
                if (_doomRunning) window.requestAnimationFrame(step);
            }
            window.requestAnimationFrame(step);
        };

        /*Return a snapshot of the player's current position, facing angle, and level.
          x/y are in DOOM map units (fixed_t >> 16).
          angleDeg is 0–360 clockwise from east, matching DOOM's convention.
          episode and map are 1-based (e.g. episode 1, map 9).*/
        window.saveState = function () {
            const ex = obj.instance.exports;

            const WEAPON_NAMES = [
                'fist', 'pistol', 'shotgun', 'chaingun',
                'rocketLauncher', 'plasmaRifle', 'bfg', 'chainsaw', 'superShotgun',
            ];
            const KEY_NAMES = [
                'blueCard', 'yellowCard', 'redCard',
                'blueSkull', 'yellowSkull', 'redSkull',
            ];
            const AMMO_NAMES = ['bullets', 'shells', 'cells', 'rockets'];

            const weapons = {};
            WEAPON_NAMES.forEach((name, i) => { weapons[name] = ex.get_weapon(i) === 1; });

            const keys = {};
            KEY_NAMES.forEach((name, i) => { keys[name] = ex.get_card(i) === 1; });

            const ammo = {};
            AMMO_NAMES.forEach((name, i) => { ammo[name] = ex.get_ammo(i); });

            const rawAngle = ex.get_player_angle();

            // Level geometry deltas: only sectors/sides that differ from the
            // baseline captured at level load.  Empty arrays mean "pristine".
            // Format:
            //   sectorChanges: [[idx, floor, ceiling], …]
            //   sideChanges:   [[idx, top,   mid,     bot], …]
            const sectorChanges = [];
            const sideChanges   = [];
            if (_levelBaseline) {
                const base = _levelBaseline;
                const numSectors = ex.get_num_sectors();
                for (let i = 0; i < numSectors; i++) {
                    const f = ex.get_sector_floor(i);
                    const c = ex.get_sector_ceiling(i);
                    if (f !== base.sectorHeights[i * 2] ||
                        c !== base.sectorHeights[i * 2 + 1]) {
                        sectorChanges.push([i, f, c]);
                    }
                }
                const numSides = ex.get_num_sides();
                for (let i = 0; i < numSides; i++) {
                    const t = ex.get_side_top(i);
                    const m = ex.get_side_mid(i);
                    const b = ex.get_side_bot(i);
                    if (t !== base.sideTextures[i * 3] ||
                        m !== base.sideTextures[i * 3 + 1] ||
                        b !== base.sideTextures[i * 3 + 2]) {
                        sideChanges.push([i, t, m, b]);
                    }
                }
            }

            return {
                // Position / orientation
                x: ex.get_player_x() / 65536,
                y: ex.get_player_y() / 65536,
                angleDeg: (rawAngle / 0x100000000) * 360,
                // Level
                episode: ex.get_gameepisode(),
                map: ex.get_gamemap(),
                // Health / armour
                health: ex.get_health(),
                armorPoints: ex.get_armor_points(),
                armorType: ex.get_armor_type(),
                // Active weapon
                readyWeapon: WEAPON_NAMES[ex.get_ready_weapon()] ?? ex.get_ready_weapon(),
                // Inventory
                backpack: ex.get_backpack() === 1,
                ...keys,
                ...weapons,
                ...ammo,
                // Level geometry deltas from the pristine level load.
                // Empty arrays mean "nothing has changed yet".
                sectorChanges,
                sideChanges,
            };
        };

        /*Apply a partial or full state snapshot produced by saveState(), plus optional
          inventory fields. Only properties that are present are applied; omitted ones
          are left unchanged.

          Position / orientation:
            x, y        – map units (same scale as saveState output)
            angleDeg    – 0–360

          Health / armour:
            health      – number
            armorPoints – number
            armorType   – 0 (none) | 1 (green) | 2 (blue/mega)

          Keys (booleans):
            blueCard, yellowCard, redCard,
            blueSkull, yellowSkull, redSkull

          Weapons (booleans):
            fist, pistol, shotgun, chaingun, rocketLauncher,
            plasmaRifle, bfg, chainsaw, superShotgun

          Active weapon (must already be owned):
            readyWeapon – one of the weapon name strings above, or its index 0–8

          Ammo (numbers):
            bullets, shells, cells, rockets

          Backpack:
            backpack    – boolean
        */
        window.setState = function (state) {
            const ex = obj.instance.exports;

            if (state.x !== undefined || state.y !== undefined) {
                const cur = saveState();
                const fx = Math.round((state.x ?? cur.x) * 65536);
                const fy = Math.round((state.y ?? cur.y) * 65536);
                ex.set_player_position(fx, fy);
            }
            if (state.angleDeg !== undefined) {
                // Convert degrees to angle_t (full circle = 2^32); >>> 0 keeps it uint32.
                const angle = ((state.angleDeg / 360) * 0x100000000) >>> 0;
                ex.set_player_angle(angle);
            }

            if (state.health !== undefined) ex.set_health(state.health);
            if (state.armorPoints !== undefined) ex.set_armor_points(state.armorPoints);
            if (state.armorType !== undefined) ex.set_armor_type(state.armorType);

            const KEY_MAP = {
                blueCard: 0, yellowCard: 1, redCard: 2,
                blueSkull: 3, yellowSkull: 4, redSkull: 5,
            };
            for (const [name, idx] of Object.entries(KEY_MAP)) {
                if (state[name] !== undefined) ex.set_card(idx, state[name] ? 1 : 0);
            }

            const WEAPON_MAP = {
                fist: 0, pistol: 1, shotgun: 2, chaingun: 3,
                rocketLauncher: 4, plasmaRifle: 5, bfg: 6,
                chainsaw: 7, superShotgun: 8,
            };
            for (const [name, idx] of Object.entries(WEAPON_MAP)) {
                if (state[name] !== undefined) ex.set_weapon(idx, state[name] ? 1 : 0);
            }
            if (state.readyWeapon !== undefined) {
                const idx = typeof state.readyWeapon === 'string'
                    ? WEAPON_MAP[state.readyWeapon]
                    : state.readyWeapon;
                if (idx !== undefined) ex.set_ready_weapon(idx);
            }

            const AMMO_MAP = { bullets: 0, shells: 1, cells: 2, rockets: 3 };
            for (const [name, idx] of Object.entries(AMMO_MAP)) {
                if (state[name] !== undefined) ex.set_ammo(idx, state[name]);
            }

            if (state.backpack !== undefined) ex.set_backpack(state.backpack ? 1 : 0);

            // Level-geometry restore.  The snapshot carries only the sectors
            // / sides that had changed from the pristine level at save time.
            // To restore exactly that view of the world we first reset every
            // sector/side to the baseline captured at level load, then apply
            // the snapshot's deltas on top.
            const hasGeomDelta = Array.isArray(state.sectorChanges) ||
                                 Array.isArray(state.sideChanges);
            if (hasGeomDelta) {
                if (!_levelBaseline) {
                    console.warn('[doom] no level baseline captured — cannot restore geometry');
                } else {
                    const n = ex.get_num_sectors();
                    const m = ex.get_num_sides();
                    if (_levelBaseline.sectorHeights.length !== n * 2 ||
                        _levelBaseline.sideTextures.length   !== m * 3) {
                        console.warn('[doom] level baseline size differs from current level — skipping geometry restore');
                    } else {
                        // 1. Reset everything to pristine
                        for (let i = 0; i < n; i++) {
                            ex.set_sector_floor(i,   _levelBaseline.sectorHeights[i * 2]);
                            ex.set_sector_ceiling(i, _levelBaseline.sectorHeights[i * 2 + 1]);
                        }
                        for (let i = 0; i < m; i++) {
                            ex.set_side_top(i, _levelBaseline.sideTextures[i * 3]);
                            ex.set_side_mid(i, _levelBaseline.sideTextures[i * 3 + 1]);
                            ex.set_side_bot(i, _levelBaseline.sideTextures[i * 3 + 2]);
                        }
                        // 2. Apply the snapshot's deltas
                        if (Array.isArray(state.sectorChanges)) {
                            for (const [idx, floor, ceiling] of state.sectorChanges) {
                                if (idx >= 0 && idx < n) {
                                    ex.set_sector_floor(idx, floor);
                                    ex.set_sector_ceiling(idx, ceiling);
                                }
                            }
                        }
                        if (Array.isArray(state.sideChanges)) {
                            for (const [idx, top, mid, bot] of state.sideChanges) {
                                if (idx >= 0 && idx < m) {
                                    ex.set_side_top(idx, top);
                                    ex.set_side_mid(idx, mid);
                                    ex.set_side_bot(idx, bot);
                                }
                            }
                        }
                    }
                }
            }
        };

        /*Cast a ray from the player's current position in their facing direction
          and return the first linedef wall hit, or null if nothing is within range.

          Returns:
            {
              linedef:     number,   // index into DOOM's lines[] array
              topTexture:  string,   // upper texture name (or "-" if none)
              midTexture:  string,   // middle texture name (or "-" if none)
              botTexture:  string,   // lower texture name (or "-" if none)
            }
        */
        window.laserPointer = function () {
            const ex = obj.instance.exports;
            const linedef = ex.laser_pointer();
            if (linedef < 0) return null;
            return {
                linedef,
                side: ex.laser_side(),
                topTexture: readCString(ex.laser_top_texture()),
                midTexture: readCString(ex.laser_mid_texture()),
                botTexture: readCString(ex.laser_bot_texture()),
            };
        };

        /*Subscribe to linedef-crossing events for a specific linedef index.
          The callback receives an object:
            {
              linedef:     number,   // index into DOOM's lines[] array
              fromSide:    number,   // 0 = crossed from front, 1 = crossed from back
              topTexture:  string,
              midTexture:  string,
              botTexture:  string,
            }
          Returns the callback so it can be passed to offLinedefCrossed later.*/
        window.onLinedefCrossed = function (linedefIdx, callback) {
            if (!linedefListeners.has(linedefIdx)) {
                linedefListeners.set(linedefIdx, new Set());
                _doomExports.watch_linedef(linedefIdx);
            }
            linedefListeners.get(linedefIdx).add(callback);
            return callback;
        };

        /*Remove a callback registered with onLinedefCrossed.
          If no callbacks remain for the linedef, the C watcher is also removed.*/
        window.offLinedefCrossed = function (linedefIdx, callback) {
            const listeners = linedefListeners.get(linedefIdx);
            if (!listeners) return;
            listeners.delete(callback);
            if (listeners.size === 0) {
                linedefListeners.delete(linedefIdx);
                _doomExports.unwatch_linedef(linedefIdx);
            }
        };

        /*Subscribe to linedef use events — fires when the player presses the
          use key (spacebar) while facing a specific linedef, whether or not
          that linedef is a special (door/switch/etc.).

          Callback receives:
            {
              linedef:    number,   // index into DOOM's lines[] array
              side:       number,   // 0 = front face, 1 = back face
              topTexture: string,
              midTexture: string,
              botTexture: string,
            }
          Returns the callback so it can be passed to offLinedefUsed.*/
        window.onLinedefUsed = function (linedefIdx, callback) {
            if (!useListeners.has(linedefIdx)) {
                useListeners.set(linedefIdx, new Set());
            }
            useListeners.get(linedefIdx).add(callback);
            return callback;
        };

        /*Remove a callback registered with onLinedefUsed.*/
        window.offLinedefUsed = function (linedefIdx, callback) {
            const listeners = useListeners.get(linedefIdx);
            if (!listeners) return;
            listeners.delete(callback);
            if (listeners.size === 0) {
                useListeners.delete(linedefIdx);
            }
        };

        /*Subscribe to the levelLoaded event. If a level has already loaded by the
          time this is called (e.g. from the console or a deferred script), the
          callback is invoked immediately with the stored detail. Otherwise it fires
          on the next levelLoaded event. Use { once: false } to receive every level
          transition rather than just the next one.*/
        window.onLevelLoaded = function (callback, { once = true } = {}) {
            if (window._lastLevelLoaded !== undefined) {
                callback(new CustomEvent('levelLoaded', { detail: window._lastLevelLoaded }));
                if (!once) {
                    document.addEventListener('levelLoaded', callback);
                }
            } else {
                document.addEventListener('levelLoaded', callback, { once });
            }
        };

        /*Subscribe to the doomQuit event, fired when the player confirms quit.
          The game loop has already been stopped by the time the callback runs.*/
        window.onDoomQuit = function(callback) {
            if (!_doomRunning) {
                callback(new CustomEvent('doomQuit'));
            } else {
                document.addEventListener('doomQuit', callback, { once: true });
            }
        };

        /*Save settings whenever the page is closed or refreshed so that
          changes made in the options menu survive without requiring the
          player to quit through DOOM's own quit dialog.*/
        window.addEventListener('beforeunload', () => {
            if (_doomRunning) obj.instance.exports.save_defaults();
        });

        /*Signal to the page that WASM is loaded and _doomLaunch is ready*/
        if (typeof window._doomReady === 'function') {
            window._doomReady();
        } else {
            console.warn('[doom] window._doomReady is not defined — game will not start. Call window._doomLaunch([]) to start manually.');
        }
    }).catch(err => {
        console.error('[doom] failed to load doom.wasm:', err);
    });
