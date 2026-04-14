// Emacs style mode select   -*- C++ -*-
//-----------------------------------------------------------------------------
//
// Copyright (C) 1993-1996 by id Software, Inc.
//
// DESCRIPTION:
//	System interface for sound — WebAssembly / Web Audio API backend.
//
//-----------------------------------------------------------------------------

static const char
rcsid[] = "$Id: i_unix.c,v 1.5 1997/02/03 22:45:10 b1 Exp $";

#include <stdio.h>
#include <string.h>

#include "i_sound.h"
#include "sounds.h"
#include "w_wad.h"
#include "z_zone.h"

// UNIX hack, to be removed.
#ifdef SNDSERV
char*  sndserver_filename = "./sndserver ";
#endif

// ── JS imports (env module) ───────────────────────────────────────────────
// SFX
// data_ptr : pointer into WASM linear memory (raw WAD lump: header + 8-bit PCM)
// data_len : byte length of the lump
// vol      : 0-15
// sep      : 0-255, 128 = centre
// pitch    : 0-255, 128 = normal
// returns  : opaque handle > 0, or 0 on failure
extern int  js_start_sound   (int data_ptr, int data_len, int vol, int sep, int pitch);
extern void js_stop_sound    (int handle);
extern int  js_sound_is_playing(int handle);
extern void js_update_sound  (int handle, int vol, int sep, int pitch);

// Music (MUS lump)
extern int  js_register_song (int data_ptr, int data_len);
extern void js_play_song     (int handle, int looping);
extern void js_pause_song    (int handle);
extern void js_resume_song   (int handle);
extern void js_stop_song     (int handle);
extern void js_unregister_song(int handle);

// ── Helpers ───────────────────────────────────────────────────────────────

// Ensure the sound lump is cached and return a pointer to it.
static void* cache_sfx_lump(sfxinfo_t* sfx)
{
    if (!sfx->data)
    {
	// Use PU_STATIC so the data outlives any single frame.
	sfx->data = W_CacheLumpNum(sfx->lumpnum, PU_STATIC);
    }
    return sfx->data;
}

// ── SFX ──────────────────────────────────────────────────────────────────

void I_SetChannels() {}

void I_SetSfxVolume(int volume)
{
    // snd_SfxVolume is already read by s_sound.c; nothing extra needed here.
    (void)volume;
}

int I_GetSfxLumpNum(sfxinfo_t* sfx)
{
    char namebuf[9];
    sprintf(namebuf, "ds%s", sfx->name);
    return W_GetNumForName(namebuf);
}

int
I_StartSound
( int	id,
  int	vol,
  int	sep,
  int	pitch,
  int	priority )
{
    sfxinfo_t*	sfx;
    void*	data;
    int		len;

    (void)priority;

    sfx  = &S_sfx[id];
    data = cache_sfx_lump(sfx);
    if (!data) return 0;

    len = W_LumpLength(sfx->lumpnum);
    return js_start_sound((int)(size_t)data, len, vol, sep, pitch);
}

void I_StopSound(int handle)
{
    js_stop_sound(handle);
}

int I_SoundIsPlaying(int handle)
{
    return js_sound_is_playing(handle);
}

void I_UpdateSound(void) {}
void I_SubmitSound(void) {}

void
I_UpdateSoundParams
( int	handle,
  int	vol,
  int	sep,
  int	pitch )
{
    js_update_sound(handle, vol, sep, pitch);
}

void I_ShutdownSound(void) {}
void I_InitSound() {}

// ── Music ─────────────────────────────────────────────────────────────────

void I_SetMusicVolume(int volume)
{
    (void)volume;
}

void I_InitMusic(void) {}
void I_ShutdownMusic(void) {}

int I_RegisterSong(void* data)
{
    // MUS header layout (all little-endian):
    //   0: char[4]  magic "MUS\x1a"
    //   4: uint16   scorelen  (byte length of the score data)
    //   6: uint16   scorestart (byte offset from header start to score data)
    // => total bytes used = scorestart + scorelen
    unsigned char* b = (unsigned char*)data;
    unsigned short scorelen, scorestart;
    int total_len;

    if (!data) return 0;
    if (b[0] != 'M' || b[1] != 'U' || b[2] != 'S') return 0;

    scorelen   = (unsigned short)(b[4] | (b[5] << 8));
    scorestart = (unsigned short)(b[6] | (b[7] << 8));
    total_len  = (int)scorestart + (int)scorelen;

    return js_register_song((int)(size_t)data, total_len);
}

void I_PlaySong     (int handle, int looping) { js_play_song(handle, looping); }
void I_PauseSong    (int handle)              { js_pause_song(handle); }
void I_ResumeSong   (int handle)              { js_resume_song(handle); }
void I_StopSong     (int handle)              { js_stop_song(handle); }
void I_UnRegisterSong(int handle)             { js_unregister_song(handle); }
