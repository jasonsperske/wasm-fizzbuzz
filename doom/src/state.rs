// WASM exports for reading and writing live game state.
// Getter/setter implementations live in linuxdoom-1.10/js_exports.c.

use std::os::raw::c_int;

extern "C" {
    // ── Getters ──────────────────────────────────────────────────────────
    fn doom_get_player_x() -> c_int;
    fn doom_get_player_y() -> c_int;
    fn doom_get_player_angle() -> u32;
    fn doom_get_gameepisode() -> c_int;
    fn doom_get_gamemap() -> c_int;

    fn doom_get_health() -> c_int;
    fn doom_get_armor_points() -> c_int;
    fn doom_get_armor_type() -> c_int;
    fn doom_get_card(index: c_int) -> c_int;
    fn doom_get_weapon(index: c_int) -> c_int;
    fn doom_get_ready_weapon() -> c_int;
    fn doom_get_ammo(index: c_int) -> c_int;
    fn doom_get_backpack() -> c_int;

    // ── Position / angle ─────────────────────────────────────────────────
    fn doom_set_player_position(x: c_int, y: c_int);
    fn doom_set_player_angle(angle: u32);

    // ── Health / armour ──────────────────────────────────────────────────
    fn doom_set_health(health: c_int);
    fn doom_set_armor_points(points: c_int);
    fn doom_set_armor_type(armor_type: c_int);

    // ── Keys (0–5) ───────────────────────────────────────────────────────
    fn doom_set_card(index: c_int, owned: c_int);

    // ── Weapons (0–8) ────────────────────────────────────────────────────
    fn doom_set_weapon(index: c_int, owned: c_int);
    fn doom_set_ready_weapon(index: c_int);

    // ── Ammo (0–3) ───────────────────────────────────────────────────────
    fn doom_set_ammo(index: c_int, amount: c_int);

    // ── Backpack ─────────────────────────────────────────────────────────
    fn doom_set_backpack(owned: c_int);

    // ── Laser pointer ────────────────────────────────────────────────────
    fn doom_laser_pointer() -> c_int;
    fn doom_laser_top_texture() -> *const u8;
    fn doom_laser_mid_texture() -> *const u8;
    fn doom_laser_bot_texture() -> *const u8;
    fn doom_get_linedef_textures(linedef_idx: c_int, side: c_int);

    // ── Linedef crossing watcher ─────────────────────────────────────────
    fn doom_watch_linedef(linedef_idx: c_int);
    fn doom_unwatch_linedef(linedef_idx: c_int);
    fn doom_check_linedef_crossings();
}

// ── Getters ───────────────────────────────────────────────────────────────

#[no_mangle] pub extern "C" fn get_player_x()     -> c_int { unsafe { doom_get_player_x() } }
#[no_mangle] pub extern "C" fn get_player_y()     -> c_int { unsafe { doom_get_player_y() } }
#[no_mangle] pub extern "C" fn get_player_angle() -> u32   { unsafe { doom_get_player_angle() } }
#[no_mangle] pub extern "C" fn get_gameepisode()  -> c_int { unsafe { doom_get_gameepisode() } }
#[no_mangle] pub extern "C" fn get_gamemap()      -> c_int { unsafe { doom_get_gamemap() } }

#[no_mangle] pub extern "C" fn get_health()        -> c_int { unsafe { doom_get_health() } }
#[no_mangle] pub extern "C" fn get_armor_points()  -> c_int { unsafe { doom_get_armor_points() } }
#[no_mangle] pub extern "C" fn get_armor_type()    -> c_int { unsafe { doom_get_armor_type() } }
#[no_mangle] pub extern "C" fn get_card(i: c_int)  -> c_int { unsafe { doom_get_card(i) } }
#[no_mangle] pub extern "C" fn get_weapon(i: c_int) -> c_int { unsafe { doom_get_weapon(i) } }
#[no_mangle] pub extern "C" fn get_ready_weapon()  -> c_int { unsafe { doom_get_ready_weapon() } }
#[no_mangle] pub extern "C" fn get_ammo(i: c_int)  -> c_int { unsafe { doom_get_ammo(i) } }
#[no_mangle] pub extern "C" fn get_backpack()      -> c_int { unsafe { doom_get_backpack() } }

// ── Position / angle ──────────────────────────────────────────────────────

#[no_mangle] pub extern "C" fn set_player_position(x: c_int, y: c_int) { unsafe { doom_set_player_position(x, y) } }
#[no_mangle] pub extern "C" fn set_player_angle(angle: u32)             { unsafe { doom_set_player_angle(angle) } }

// ── Health / armour ───────────────────────────────────────────────────────

#[no_mangle] pub extern "C" fn set_health(health: c_int)          { unsafe { doom_set_health(health) } }
#[no_mangle] pub extern "C" fn set_armor_points(points: c_int)    { unsafe { doom_set_armor_points(points) } }
#[no_mangle] pub extern "C" fn set_armor_type(armor_type: c_int)  { unsafe { doom_set_armor_type(armor_type) } }

// ── Keys ──────────────────────────────────────────────────────────────────

#[no_mangle] pub extern "C" fn set_card(index: c_int, owned: c_int) { unsafe { doom_set_card(index, owned) } }

// ── Weapons ───────────────────────────────────────────────────────────────

#[no_mangle] pub extern "C" fn set_weapon(index: c_int, owned: c_int) { unsafe { doom_set_weapon(index, owned) } }
#[no_mangle] pub extern "C" fn set_ready_weapon(index: c_int)         { unsafe { doom_set_ready_weapon(index) } }

// ── Ammo ──────────────────────────────────────────────────────────────────

#[no_mangle] pub extern "C" fn set_ammo(index: c_int, amount: c_int) { unsafe { doom_set_ammo(index, amount) } }

// ── Backpack ──────────────────────────────────────────────────────────────

#[no_mangle] pub extern "C" fn set_backpack(owned: c_int) { unsafe { doom_set_backpack(owned) } }

// ── Laser pointer ─────────────────────────────────────────────────────────

#[no_mangle] pub extern "C" fn laser_pointer()                              -> c_int    { unsafe { doom_laser_pointer() } }
#[no_mangle] pub extern "C" fn laser_top_texture()                          -> *const u8 { unsafe { doom_laser_top_texture() } }
#[no_mangle] pub extern "C" fn laser_mid_texture()                          -> *const u8 { unsafe { doom_laser_mid_texture() } }
#[no_mangle] pub extern "C" fn laser_bot_texture()                          -> *const u8 { unsafe { doom_laser_bot_texture() } }
#[no_mangle] pub extern "C" fn get_linedef_textures(idx: c_int, side: c_int) { unsafe { doom_get_linedef_textures(idx, side) } }

// ── Linedef crossing watcher ──────────────────────────────────────────────

#[no_mangle] pub extern "C" fn watch_linedef(idx: c_int)   { unsafe { doom_watch_linedef(idx) } }
#[no_mangle] pub extern "C" fn unwatch_linedef(idx: c_int) { unsafe { doom_unwatch_linedef(idx) } }
#[no_mangle] pub extern "C" fn check_linedef_crossings()   { unsafe { doom_check_linedef_crossings() } }
