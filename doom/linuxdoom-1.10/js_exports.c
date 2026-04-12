// Getter functions exported to JavaScript via Rust/WASM.
// Access live game state: player position, angle, and current level.

#include "doomstat.h" // players[], consoleplayer, gameepisode, gamemap

// fixed_t is 16.16 fixed-point (divide by 65536 in JS to get map units).
// angle_t is a 32-bit value where 0xFFFFFFFF = 360 degrees.

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
