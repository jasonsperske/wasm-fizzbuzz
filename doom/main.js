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
        js_doom_quit: () => {
            _doomRunning = false;
            document.dispatchEvent(new CustomEvent('doomQuit'));
        },
        js_level_loaded: (episode, map) => {
            window._lastLevelLoaded = { episode, map };
            // C has already cleared the watcher list for the new level.
            // Re-register every linedef that JS still has callbacks for.
            linedefListeners.forEach((_, idx) => _doomExports.watch_linedef(idx));
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

// Shared state needed by importObject.env handlers before obj is available.
const linedefListeners = new Map(); // linedefIdx → Set<callback>  (crossing)
const useListeners = new Map(); // linedefIdx → Set<callback>  (use/activate)
let _doomExports = null;            // set once WASM is instantiated
let _doomRunning = true;            // cleared by js_doom_quit to stop the loop

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

        /*Signal to the page that WASM is loaded and _doomLaunch is ready*/
        if (typeof window._doomReady === 'function') {
            window._doomReady();
        } else {
            console.warn('[doom] window._doomReady is not defined — game will not start. Call window._doomLaunch([]) to start manually.');
        }
    }).catch(err => {
        console.error('[doom] failed to load doom.wasm:', err);
    });
