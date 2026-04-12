// Getter and setter functions exported to JavaScript via Rust/WASM.
// Access and mutate live game state: player position, angle, inventory, and level.

#include "doomstat.h" // players[], consoleplayer, gameepisode, gamemap
#include "p_local.h"  // P_TeleportMove, P_SetupPsprites

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
