use std::os::raw::{c_int};
use std::ptr::addr_of;

#[allow(non_camel_case_types)]
pub type c_long_double = ::std::os::raw::c_double; //?

// C libraries
extern "C" {
    // d_main.c
    fn D_DoomMain();
    fn D_DoomLoop_loop();

    // m_argv.c
    static mut myargc: c_int;
    static mut myargv: *const *const u8; //c_char;

    // js_exports.c — live game state accessors
    fn doom_get_player_x() -> c_int;
    fn doom_get_player_y() -> c_int;
    fn doom_get_player_angle() -> u32;
    fn doom_get_gameepisode() -> c_int;
    fn doom_get_gamemap() -> c_int;
}

// Re-export game state accessors so JS can call them directly on the WASM instance.
#[no_mangle] pub extern "C" fn get_player_x()     -> c_int { unsafe { doom_get_player_x() } }
#[no_mangle] pub extern "C" fn get_player_y()     -> c_int { unsafe { doom_get_player_y() } }
#[no_mangle] pub extern "C" fn get_player_angle() -> u32   { unsafe { doom_get_player_angle() } }
#[no_mangle] pub extern "C" fn get_gameepisode()  -> c_int { unsafe { doom_get_gameepisode() } }
#[no_mangle] pub extern "C" fn get_gamemap()      -> c_int { unsafe { doom_get_gamemap() } }

// Macros to print to JavaScript Console.
use doom::{log, println};

static mut SINGLE_THREAD_ERRNO: c_int = 0; // YOLO
#[no_mangle]
extern "C" fn ___errno_location() -> *const c_int {
    addr_of!(SINGLE_THREAD_ERRNO)
}


#[link(wasm_import_module = "js")]
extern "C" {
    // i32 timestamps in milliseconds should be enough for over 500hours of DooM.
    fn js_milliseconds_since_start() -> i32;
}

//
// I_GetTime
// Doom comment says: returns time in 1/70th second tics.
// But it's actually more 1/35 second tics, i.e. optimized for 35FPS
// I.e. one tic every 28.572ms.
// Returns a monotonically increasing number of ticks.
//
#[no_mangle]
extern "C" fn I_GetTime() -> c_int {
    const TICRATE: c_int = 35;

    let ms = unsafe { js_milliseconds_since_start() };

    // Basically, there should be no need to record a basetime,
    // since performance.now() shold roughly start at 0.
    static mut BASETIME: c_int = 0;
    let base = unsafe {
        if BASETIME == 0 {
            BASETIME = ms;
            crate::log!("BASETIME initialized to {}", BASETIME);
        }
        BASETIME
    };
    (ms-base)*TICRATE/1000
}


// Rust requires fn main() to have signature fn() — its ABI cannot be changed.
// JS calls doom_start() instead, which receives argc/argv from the launcher.
fn main() {}

// argc and argv are written into WASM linear memory by the JS launcher
// (see setupArgv in main.js) and passed here directly by the JS caller.
// The pointers remain valid for the lifetime of the page.
#[no_mangle]
pub extern "C" fn doom_start(argc: c_int, argv: *const *const u8) {
    log!(
        "Hello, {}! Answer={} ({:b} in binary)",
        "World, from JS Console",
        42,
        42
    );

    std::panic::set_hook(Box::new(|panic_info| {
        log!("PANIC!!");
        let p = match panic_info.payload().downcast_ref::<&str>() {
            Some(s) => s.to_string(),
            None => String::from("<no further information>"),
        };
        let l = match panic_info.location() {
            Some(l) => format!("in file '{}' at line {}", l.file(), l.line()),
            None => String::from("but can't get location information..."),
        };
        log!("panic occurred: \"{}\" {}\n{:?}", p, l, panic_info);
    }));

    println!("Hello, world from rust! 🦀🦀🦀 (println! working)");

    unsafe {
        myargc = argc;
        myargv = argv;
        D_DoomMain();
    };
}

#[no_mangle]
pub extern "C" fn doom_loop_step() {
    unsafe { D_DoomLoop_loop() };
}
