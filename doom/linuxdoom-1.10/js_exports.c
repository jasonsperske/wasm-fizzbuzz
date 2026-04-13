// Getter and setter functions exported to JavaScript via Rust/WASM.
// Access and mutate live game state: player position, angle, inventory, and level.

#include <string.h>

#include "doomstat.h" // players[], consoleplayer, gameepisode, gamemap
#include "p_local.h"  // P_TeleportMove, P_SetupPsprites, P_PathTraverse, P_PointOnLineSide
#include "r_state.h"  // lines, sides
#include "tables.h"   // finecosine, finesine, ANGLETOFINESHIFT
#include "m_fixed.h"  // FixedMul, FRACUNIT

// fixed_t is 16.16 fixed-point (divide by 65536 in JS to get map units).
// angle_t is a 32-bit value where 0xFFFFFFFF = 360 degrees.

// ── Getters ───────────────────────────────────────────────────────────────

int doom_get_player_x(void) {
    if (players[consoleplayer].mo == NULL) return 0;
    return players[consoleplayer].mo->x;
}

int doom_get_player_y(void) {
    if (players[consoleplayer].mo == NULL) return 0;
    return players[consoleplayer].mo->y;
}

unsigned int doom_get_player_angle(void) {
    if (players[consoleplayer].mo == NULL) return 0;
    return players[consoleplayer].mo->angle;
}

int doom_get_gameepisode(void) {
    return gameepisode;
}

int doom_get_gamemap(void) {
    return gamemap;
}

int doom_get_health(void) {
    if (players[consoleplayer].mo == NULL) return 0;
    return players[consoleplayer].mo->health;
}

int doom_get_armor_points(void) { return players[consoleplayer].armorpoints; }
int doom_get_armor_type(void)   { return players[consoleplayer].armortype; }

// index: 0=blueCard 1=yellowCard 2=redCard 3=blueSkull 4=yellowSkull 5=redSkull
int doom_get_card(int index) {
    if (index < 0 || index >= NUMCARDS) return 0;
    return players[consoleplayer].cards[index] ? 1 : 0;
}

// index: 0=fist 1=pistol 2=shotgun 3=chaingun 4=rocketLauncher
//        5=plasmaRifle 6=bfg 7=chainsaw 8=superShotgun
int doom_get_weapon(int index) {
    if (index < 0 || index >= NUMWEAPONS) return 0;
    return players[consoleplayer].weaponowned[index] ? 1 : 0;
}

int doom_get_ready_weapon(void) { return (int)players[consoleplayer].readyweapon; }

// index: 0=bullets 1=shells 2=cells 3=rockets
int doom_get_ammo(int index) {
    if (index < 0 || index >= NUMAMMO) return 0;
    return players[consoleplayer].ammo[index];
}

int doom_get_backpack(void) { return players[consoleplayer].backpack ? 1 : 0; }

// ── Position / angle setters ──────────────────────────────────────────────

// Teleports the player to (x, y) in fixed_t units using P_TeleportMove so
// the BSP and sector links are updated correctly.  Zeroes momentum so the
// player doesn't keep sliding after the warp.
void doom_set_player_position(int x, int y) {
    player_t *p = &players[consoleplayer];
    if (p->mo == NULL) return;

    if (!P_TeleportMove(p->mo, x, y)) return; // destination blocked

    p->mo->z     = p->mo->floorz;
    p->viewz     = p->mo->z + p->viewheight;
    p->mo->momx  = 0;
    p->mo->momy  = 0;
    p->mo->momz  = 0;
}

void doom_set_player_angle(unsigned int angle) {
    if (players[consoleplayer].mo == NULL) return;
    players[consoleplayer].mo->angle = angle;
}

// ── Health / armour ───────────────────────────────────────────────────────

void doom_set_health(int health) {
    player_t *p = &players[consoleplayer];
    if (p->mo == NULL) return;
    p->health    = health;
    p->mo->health = health;
}

void doom_set_armor_points(int points) {
    players[consoleplayer].armorpoints = points;
}

// type: 0 = none, 1 = green armour, 2 = blue (mega) armour
void doom_set_armor_type(int type) {
    players[consoleplayer].armortype = type;
}

// ── Keys ──────────────────────────────────────────────────────────────────
// index: 0=blueCard 1=yellowCard 2=redCard 3=blueSkull 4=yellowSkull 5=redSkull

void doom_set_card(int index, int owned) {
    if (index < 0 || index >= NUMCARDS) return;
    players[consoleplayer].cards[index] = owned ? true : false;
}

// ── Weapons ───────────────────────────────────────────────────────────────
// index: 0=fist 1=pistol 2=shotgun 3=chaingun 4=rocketLauncher
//        5=plasmaRifle 6=bfg 7=chainsaw 8=superShotgun

void doom_set_weapon(int index, int owned) {
    if (index < 0 || index >= NUMWEAPONS) return;
    players[consoleplayer].weaponowned[index] = owned ? true : false;
}

// Switch the player's active weapon and bring it up on screen.
void doom_set_ready_weapon(int index) {
    if (index < 0 || index >= NUMWEAPONS) return;
    player_t *p = &players[consoleplayer];
    if (!p->weaponowned[index]) return; // can't ready a weapon they don't have
    p->readyweapon = (weapontype_t)index;
    P_SetupPsprites(p);
}

// ── Ammo ──────────────────────────────────────────────────────────────────
// index: 0=bullets 1=shells 2=cells 3=rockets

void doom_set_ammo(int index, int amount) {
    if (index < 0 || index >= NUMAMMO) return;
    player_t *p = &players[consoleplayer];
    if (amount > p->maxammo[index]) amount = p->maxammo[index];
    p->ammo[index] = amount;
}

// ── Backpack ──────────────────────────────────────────────────────────────

void doom_set_backpack(int owned) {
    players[consoleplayer].backpack = owned ? true : false;
}

// ── Laser pointer ─────────────────────────────────────────────────────────
//
// Casts a ray from the player's position in the direction they are facing and
// returns information about the first linedef wall it hits.
//
// texture_t is defined only in r_data.c, so we use a stub struct that covers
// just the name field which is guaranteed to be at offset 0.
typedef struct { char name[8]; } laser_tex_stub_t;
extern laser_tex_stub_t** textures;

// Results written by the traversal callback and read by the getters below.
static int          laser_linedef_index = -1;
static int          laser_side = -1;
static char         laser_top_tex[9];
static char         laser_mid_tex[9];
static char         laser_bot_tex[9];

// Copy an 8-char (possibly non-null-terminated) WAD texture name into a
// 9-char buffer, trimming trailing spaces.  Index 0 means "no texture".
static void copy_tex_name(char *dst, int idx) {
    if (idx <= 0) { dst[0] = '-'; dst[1] = '\0'; return; }
    memcpy(dst, textures[idx]->name, 8);
    dst[8] = '\0';
    int i = 7;
    while (i > 0 && (dst[i] == ' ' || dst[i] == '\0')) i--;
    dst[i + 1] = '\0';
}

// P_PathTraverse callback: stops at the very first line encountered.
static line_t* laser_hit_line;
static boolean laser_trav(intercept_t* in) {
    if (!in->isaline) return true;  // skip mobjs, keep going
    laser_hit_line = in->d.line;
    return false;                   // stop traversal
}

// Cast the ray and populate the static result buffers.
// Returns the linedef index (into the global lines[] array), or -1 if nothing
// was hit within range.
int doom_laser_pointer(void) {
    player_t* p = &players[consoleplayer];
    if (p->mo == NULL) return -1;

    fixed_t x = p->mo->x;
    fixed_t y = p->mo->y;
    int     an = p->mo->angle >> ANGLETOFINESHIFT;

    // 2048 map-unit trace — comfortably covers any normal room.
    fixed_t dist = 2048 * FRACUNIT;
    fixed_t x2   = x + FixedMul(dist, finecosine[an]);
    fixed_t y2   = y + FixedMul(dist, finesine[an]);

    laser_hit_line = NULL;
    P_PathTraverse(x, y, x2, y2, PT_ADDLINES, laser_trav);

    if (laser_hit_line == NULL) { laser_linedef_index = -1; laser_side = -1; return -1; }

    laser_linedef_index = (int)(laser_hit_line - lines);

    // Which side is facing the player?  0 = front, 1 = back.
    int side = P_PointOnLineSide(x, y, laser_hit_line);
    laser_side = side;

    if (laser_hit_line->sidenum[side] == -1) {
        // One-sided line viewed from its back — no sidedef, no textures.
        laser_top_tex[0] = '-'; laser_top_tex[1] = '\0';
        laser_mid_tex[0] = '-'; laser_mid_tex[1] = '\0';
        laser_bot_tex[0] = '-'; laser_bot_tex[1] = '\0';
    } else {
        side_t* sd = &sides[laser_hit_line->sidenum[side]];
        copy_tex_name(laser_top_tex, sd->toptexture);
        copy_tex_name(laser_mid_tex, sd->midtexture);
        copy_tex_name(laser_bot_tex, sd->bottomtexture);
    }

    return laser_linedef_index;
}

// Texture name accessors — call these after doom_laser_pointer() returns >= 0.
// Return pointers into static buffers (valid until next call to doom_laser_pointer).
const char* doom_laser_top_texture(void) { return laser_top_tex; }
const char* doom_laser_mid_texture(void) { return laser_mid_tex; }
const char* doom_laser_bot_texture(void) { return laser_bot_tex; }
int         doom_laser_side(void)        { return laser_side; }

// Populate the shared texture name buffers for an arbitrary linedef/side.
// side: 0 = front, 1 = back.  Call the laser_*_texture() getters afterward.
void doom_get_linedef_textures(int linedef_idx, int side) {
    if (linedef_idx < 0 || linedef_idx >= numlines) {
        laser_top_tex[0] = laser_mid_tex[0] = laser_bot_tex[0] = '-';
        laser_top_tex[1] = laser_mid_tex[1] = laser_bot_tex[1] = '\0';
        return;
    }
    line_t* ld = &lines[linedef_idx];
    if (ld->sidenum[side] == -1) {
        laser_top_tex[0] = laser_mid_tex[0] = laser_bot_tex[0] = '-';
        laser_top_tex[1] = laser_mid_tex[1] = laser_bot_tex[1] = '\0';
        return;
    }
    side_t* sd = &sides[ld->sidenum[side]];
    copy_tex_name(laser_top_tex, sd->toptexture);
    copy_tex_name(laser_mid_tex, sd->midtexture);
    copy_tex_name(laser_bot_tex, sd->bottomtexture);
}

// ── Linedef crossing watcher ──────────────────────────────────────────────
//
// JS calls watch_linedef(idx) to register interest in a linedef.
// doom_check_linedef_crossings() should be called each game tic (from JS
// after doom_loop_step).  When the player's side relative to a watched line
// changes, js_linedef_crossed(linedef_idx, from_side) is called.

// JS import — defined in importObject.env in main.js.
extern void js_linedef_crossed(int linedef_idx, int from_side);

#define MAX_WATCHED_LINES 64

typedef struct {
    int linedef_idx;
    int last_side;  // 0 or 1; -1 = not yet sampled
} watched_entry_t;

static watched_entry_t watched[MAX_WATCHED_LINES];
static int            watched_count = 0;

void doom_watch_linedef(int linedef_idx) {
    if (linedef_idx < 0 || linedef_idx >= numlines) return;
    // Ignore if already watched.
    for (int i = 0; i < watched_count; i++)
        if (watched[i].linedef_idx == linedef_idx) return;
    if (watched_count >= MAX_WATCHED_LINES) return;
    watched[watched_count].linedef_idx = linedef_idx;
    watched[watched_count].last_side   = -1;
    watched_count++;
}

// Called from G_DoLoadLevel before the new level's lines[] is populated.
// Clears all watchers so stale indices from the old level don't cause
// out-of-bounds memory accesses.  JS re-registers watchers on levelLoaded.
void doom_clear_linedef_watchers(void) {
    watched_count = 0;
}

void doom_unwatch_linedef(int linedef_idx) {
    for (int i = 0; i < watched_count; i++) {
        if (watched[i].linedef_idx == linedef_idx) {
            watched[i] = watched[--watched_count]; // swap with last
            return;
        }
    }
}

// Returns true if (px, py) projects onto the finite extent of the line segment
// (i.e. the perpendicular foot falls between v1 and v2).
// Uses 64-bit arithmetic to avoid fixed_t overflow on large maps.
static boolean within_linedef_extent(fixed_t px, fixed_t py, line_t* ld) {
    long long ex    = (long long)(px - ld->v1->x);
    long long ey    = (long long)(py - ld->v1->y);
    long long dx    = (long long)ld->dx;
    long long dy    = (long long)ld->dy;
    long long dot   = ex * dx + ey * dy;
    long long lenSq = dx * dx + dy * dy;
    return dot >= 0 && dot <= lenSq;
}

// Called each tic from JS.  Detects side changes for every watched linedef.
// last_side is always updated so state stays consistent; the event only fires
// when the player is within the finite extent of the segment.
void doom_check_linedef_crossings(void) {
    player_t* p = &players[consoleplayer];
    if (p->mo == NULL) return;

    fixed_t px = p->mo->x;
    fixed_t py = p->mo->y;

    for (int i = 0; i < watched_count; i++) {
        line_t* ld  = &lines[watched[i].linedef_idx];
        int cur_side = P_PointOnLineSide(px, py, ld);

        if (watched[i].last_side == -1) {
            // First sample — just record, don't fire.
            watched[i].last_side = cur_side;
        } else if (cur_side != watched[i].last_side) {
            int from_side = watched[i].last_side;
            watched[i].last_side = cur_side;
            if (within_linedef_extent(px, py, ld)) {
                js_linedef_crossed(watched[i].linedef_idx, from_side);
            }
        }
    }
}
