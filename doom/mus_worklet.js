// AudioWorkletProcessor that renders DOOM's MUS music off the main thread.
//
// Instantiates a SECOND doom.wasm instance (with its own 16 MiB of linear
// memory) inside the worklet's AudioWorkletGlobalScope.  We only ever call
// the mus_* exports — all other DOOM imports are stubbed as no-ops.
//
// Wire protocol (main → worklet port messages):
//   { type: 'init',       wasmBytes, sfBytes, sampleRate }
//   { type: 'register',   handle, musBytes }
//   { type: 'play',       handle, looping }
//   { type: 'stop',       handle }
//   { type: 'pause',      handle }
//   { type: 'unregister', handle }
//   { type: 'statsReset' }
//
// Worklet → main:
//   { type: 'ready' }
//   { type: 'stats', count, sumMs, maxMs, lastMs, blockSize, sampleRate, uptimeMs }

'use strict';

const BLOCK = 128; // AudioWorklet fixed render quantum

class MusSynthProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();

        this._exports = null;
        this._memory = null;
        this._leftPtr = 0;
        this._rightPtr = 0;
        this._ready = false;

        // Per-callback timing stats.  AudioWorkletGlobalScope exposes neither
        // performance.now() nor a high-res clock, so we use Date.now() — 1 ms
        // granularity.  Individual renders are sub-ms; the sum is accurate to
        // about the granularity, and that's what we use for the CPU % metric.
        this._count = 0;
        this._sumMs = 0;
        this._maxMs = 0;
        this._lastMs = 0;
        this._startTime = currentTime; // AudioWorkletGlobalScope

        // External (main-thread-assigned) handle → internal (rustysynth) handle.
        // The Rust SONGS vec is strictly monotonic, but mus_register_song can
        // return 0 on parse failure, which would desync the two sides if we
        // relied on position alone.  Map keeps them independent.
        this._handleMap = new Map();

        // Periodic stats push: once per ~250ms of audio
        this._statsEvery = Math.round(sampleRate / BLOCK / 4);
        this._ticksSinceStats = 0;

        // Messages that arrive before _init resolves get queued so that
        // register/play requests sent during worklet spin-up aren't lost.
        this._pendingMsgs = [];

        this.port.onmessage = (ev) => this._handleMessage(ev.data);
    }

    async _init(wasmBytes, sfBytes, outSampleRate) {
        // 108 pages = 6.75 MiB initial; wasm may grow as rustysynth allocates.
        this._memory = new WebAssembly.Memory({ initial: 108 });

        const stubU = () => 0;  // returns uint
        const stubV = () => {}; // returns void

        const importObject = {
            js: {
                js_milliseconds_since_start: () => currentTime * 1000,
                js_console_log: (ptr, len) => {
                    const bytes = new Uint8Array(this._memory.buffer, ptr, len);
                    const msg = new TextDecoder('utf8').decode(bytes);
                    console.log('[mus-worklet]', msg);
                },
                js_stdout: stubV,
                js_stderr: stubV,
                js_draw_screen: stubV,
            },
            env: {
                memory: this._memory,
                js_start_sound: stubU,
                js_stop_sound: stubV,
                js_sound_is_playing: stubU,
                js_update_sound: stubV,
                // All music calls happen from main thread directly into this worklet,
                // never from DOOM's C code (because DOOM isn't running in here).
                js_register_song: stubU,
                js_play_song: stubV,
                js_pause_song: stubV,
                js_resume_song: stubV,
                js_stop_song: stubV,
                js_unregister_song: stubV,
                js_doom_quit: stubV,
                js_doom_error: stubV,
                js_level_loaded: stubV,
                js_save_config: stubV,
                js_load_config: stubU,
                js_linedef_used: stubV,
                js_linedef_crossed: stubV,
            },
        };

        const { instance } = await WebAssembly.instantiate(wasmBytes, importObject);
        this._exports = instance.exports;

        // Copy the soundfont into wasm memory and initialise the synth.
        const sfPtr = this._exports.mus_alloc(sfBytes.byteLength);
        if (!sfPtr) throw new Error('mus_alloc(soundfont) failed');
        new Uint8Array(this._memory.buffer, sfPtr, sfBytes.byteLength).set(new Uint8Array(sfBytes));
        const ok = this._exports.mus_init(sfPtr, sfBytes.byteLength, outSampleRate | 0);
        this._exports.mus_free(sfPtr);
        if (!ok) throw new Error('mus_init returned 0');

        // Reserve per-block PCM buffers (stable for the worklet's lifetime).
        this._leftPtr  = this._exports.mus_alloc(BLOCK * 4);
        this._rightPtr = this._exports.mus_alloc(BLOCK * 4);
        if (!this._leftPtr || !this._rightPtr) throw new Error('mus_alloc(pcm) failed');

        this._ready = true;
        this.port.postMessage({ type: 'ready' });

        // Drain anything queued while WASM was instantiating.
        const queued = this._pendingMsgs;
        this._pendingMsgs = [];
        for (const m of queued) this._handleMessage(m);
    }

    _handleMessage(msg) {
        if (msg.type === 'init') {
            this._init(msg.wasmBytes, msg.sfBytes, msg.sampleRate)
                .catch(err => {
                    console.error('[mus-worklet] init failed:', err);
                    this.port.postMessage({ type: 'error', message: String(err) });
                });
            return;
        }
        if (!this._ready && msg.type !== 'statsReset') {
            this._pendingMsgs.push(msg);
            return;
        }
        switch (msg.type) {
            case 'register': {
                const len = msg.musBytes.byteLength;
                const ptr = this._exports.mus_alloc(len);
                if (!ptr) { this._handleMap.set(msg.handle, 0); return; }
                new Uint8Array(this._memory.buffer, ptr, len).set(new Uint8Array(msg.musBytes));
                const internal = this._exports.mus_register_song(ptr, len);
                this._exports.mus_free(ptr);
                this._handleMap.set(msg.handle, internal);
                return;
            }
            case 'play': {
                const h = this._handleMap.get(msg.handle) | 0;
                this._exports.mus_play_song(h, msg.looping ? 1 : 0);
                return;
            }
            case 'stop': {
                const h = this._handleMap.get(msg.handle) | 0;
                this._exports.mus_stop_song(h);
                return;
            }
            case 'pause': {
                const h = this._handleMap.get(msg.handle) | 0;
                this._exports.mus_pause_song(h);
                return;
            }
            case 'unregister': {
                const h = this._handleMap.get(msg.handle) | 0;
                this._exports.mus_unregister_song(h);
                this._handleMap.delete(msg.handle);
                return;
            }
            case 'statsReset':
                this._count = 0;
                this._sumMs = 0;
                this._maxMs = 0;
                this._lastMs = 0;
                this._startTime = currentTime;
                return;
        }
    }

    process(_inputs, outputs) {
        try {
            return this._process(outputs);
        } catch (err) {
            if (!this._errorReported) {
                this._errorReported = true;
                this.port.postMessage({
                    type: 'error',
                    message: String(err && err.stack || err),
                });
            }
            // Return true so Chrome keeps calling us — we won't throw again
            // because _errorReported is sticky.
            return true;
        }
    }

    _process(outputs) {
        const out = outputs[0];
        if (!this._ready) {
            // Silence until init completes.
            for (let ch = 0; ch < out.length; ch++) out[ch].fill(0);
            return true;
        }

        const t0 = Date.now();

        this._exports.mus_render(this._leftPtr, this._rightPtr, BLOCK);
        const buf = this._memory.buffer;
        out[0].set(new Float32Array(buf, this._leftPtr,  BLOCK));
        if (out.length > 1) {
            out[1].set(new Float32Array(buf, this._rightPtr, BLOCK));
        }

        const dt = Date.now() - t0;
        this._count++;
        this._sumMs += dt;
        if (dt > this._maxMs) this._maxMs = dt;
        this._lastMs = dt;

        if (++this._ticksSinceStats >= this._statsEvery) {
            this._ticksSinceStats = 0;
            this.port.postMessage({
                type: 'stats',
                count: this._count,
                sumMs: this._sumMs,
                maxMs: this._maxMs,
                lastMs: this._lastMs,
                blockSize: BLOCK,
                sampleRate: sampleRate,
                uptimeMs: (currentTime - this._startTime) * 1000,
            });
        }
        return true;
    }
}

registerProcessor('mus-synth', MusSynthProcessor);
