'use strict';
var memory = new WebAssembly.Memory({ initial : 108 });

/*stdout and stderr goes here*/
const output = document.getElementById("output");

function readWasmString(offset, length) {
    const bytes = new Uint8Array(memory.buffer, offset, length);
    return new TextDecoder('utf8').decode(bytes);
}

function consoleLogString(offset, length) {
    const string = readWasmString(offset, length);
    console.log("\"" + string + "\"");
}

function appendOutput(style) {
    return function(offset, length) {
        const lines = readWasmString(offset, length).split('\n');
        for (var i=0; i<lines.length; ++i) {
            if (lines[i].length == 0) {
                continue;
            }
            console.log(lines[i]);
        }
    }
}


/*doom is rendered here*/
const canvas = document.getElementById('screen');
const doom_screen_width = 320*2;
const doom_screen_height = 200*2;

function drawCanvas(ptr) {
    var doom_screen = new Uint8ClampedArray(memory.buffer, ptr, doom_screen_width*doom_screen_height*4)
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
        memory: memory
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

console.log('[doom] fetching doom.wasm...');
WebAssembly.instantiateStreaming(fetch('doom.wasm'), importObject)
    .then(obj => {
    console.log('[doom] wasm loaded. exports:', Object.keys(obj.instance.exports));

    /*Launch DOOM with the given extra arguments (e.g. ["-warp", "1", "9"]).
      argv[0] is always "doom". Call this once on startup.*/
    window._doomLaunch = function(extraArgs) {
        const args = ["doom", ...extraArgs];
        console.log('[doom] _doomLaunch called with argv:', args);
        const { argc, argvPtr } = setupArgv(args);
        console.log('[doom] argv written to wasm memory — argc:', argc, 'argvPtr:', argvPtr);

        if (typeof obj.instance.exports.doom_start !== 'function') {
            console.error('[doom] doom_start not found in exports! Available:', Object.keys(obj.instance.exports));
            return;
        }

        /*Initialize Doom*/
        console.log('[doom] calling doom_start...');
        obj.instance.exports.doom_start(argc, argvPtr);
        console.log('[doom] doom_start returned');


        /*input handling*/
        let doomKeyCode = function(keyCode) {
            // Doom seems to use mostly the same keycodes, except for the following (maybe I'm missing a few.)
            switch (keyCode) {
            case 8:
                return 127; // KEY_BACKSPACE
            case 17:
                return (0x80+0x1d); // KEY_RCTRL
            case 18:
                return (0x80+0x38); // KEY_RALT
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
                if (keyCode >= 112 /*F1*/ && keyCode <= 123 /*F12*/ ) {
                return keyCode + 75; // KEY_F1
                }
                return keyCode;
            }
        };
        let keyDown = function(keyCode) {obj.instance.exports.add_browser_event(0 /*KeyDown*/, keyCode);};
        let keyUp = function(keyCode) {obj.instance.exports.add_browser_event(1 /*KeyUp*/, keyCode);};

        /*keyboard input*/
        canvas.addEventListener('keydown', function(event) {
            keyDown(doomKeyCode(event.keyCode));
            event.preventDefault();
        }, false);
        canvas.addEventListener('keyup', function(event) {
            keyUp(doomKeyCode(event.keyCode));
            event.preventDefault();
        }, false);

        /*mobile touch input*/
        [["enterButton", 13],
         ["leftButton", 0xac],
         ["rightButton", 0xae],
         ["upButton", 0xad],
         ["downButton", 0xaf],
         ["ctrlButton", 0x80+0x1d],
         ["spaceButton", 32],
         ["altButton", 0x80+0x38]].forEach(([elementID, keyCode]) => {
            console.log(elementID + " for " + keyCode);
            var button = document.getElementById(elementID);
            //button.addEventListener("click", () => {keyDown(keyCode); keyUp(keyCode)} );
            button.addEventListener("touchstart", () => keyDown(keyCode));
            button.addEventListener("touchend", () => keyUp(keyCode));
            button.addEventListener("touchcancel", () => keyUp(keyCode));
        });

        /*hint that the canvas should have focus to capture keyboard events*/
        const focushint = document.getElementById("focushint");
        const printFocusInHint = function(e) {
            focushint.innerText = "Keyboard events will be captured as long as the DOOM canvas has focus.";
            focushint.style.fontWeight = "normal";
        };
        canvas.addEventListener('focusin', printFocusInHint, false);

        canvas.addEventListener('focusout', function(e) {
            focushint.innerText = "Click on the canvas to capture input and start playing.";
            focushint.style.fontWeight = "bold";
        }, false);

        canvas.focus();
        printFocusInHint();

        /*Main game loop*/
        console.log('[doom] starting game loop');
        function step(timestamp) {
            obj.instance.exports.doom_loop_step();
            window.requestAnimationFrame(step);
        }
        window.requestAnimationFrame(step);
    };

    /*Return a snapshot of the player's current position, facing angle, and level.
      x/y are in DOOM map units (fixed_t >> 16).
      angleDeg is 0–360 clockwise from east, matching DOOM's convention.
      episode and map are 1-based (e.g. episode 1, map 9).*/
    window.saveState = function() {
        const x     = obj.instance.exports.get_player_x();
        const y     = obj.instance.exports.get_player_y();
        const angle = obj.instance.exports.get_player_angle();
        const ep    = obj.instance.exports.get_gameepisode();
        const map   = obj.instance.exports.get_gamemap();
        return {
            x:          x / 65536,           // fixed_t → map units
            y:          y / 65536,
            angleDeg:   (angle / 0x100000000) * 360,
            episode:    ep,
            map:        map,
        };
    };

    /*Signal to the page that WASM is loaded and _doomLaunch is ready*/
    console.log('[doom] wasm ready. window._doomReady is:', typeof window._doomReady);
    if (typeof window._doomReady === 'function') {
        window._doomReady();
    } else {
        console.warn('[doom] window._doomReady is not defined — game will not start. Call window._doomLaunch([]) to start manually.');
    }
}).catch(err => {
    console.error('[doom] failed to load doom.wasm:', err);
});
