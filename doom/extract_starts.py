#!/usr/bin/env python3
"""
Extract player start positions (types 1-4) and deathmatch start positions
(type 11) from a DOOM WAD file and merge them into the per-level JSON files
(e.g. E1M1.json) under the existing "doors" object.

Each point is keyed as "{map}-{label}", e.g. "E1M1-normal". Labels are
single lowercase English words matching the style of existing door keys:

    player 1 -> "normal"      deathmatch spots -> "dm1", "dm2", ...
    player 2 -> "partner"
    player 3 -> "ally"
    player 4 -> "buddy"

Angle convention matches DOOM: 0-360 clockwise from east.

Usage:
    python3 extract_starts.py [--wad doom1.wad] [--dir .] [--dry-run]
"""

import argparse
import json
import os
import re
import struct
import sys
from collections import OrderedDict

# DOOM "thing" type numbers for player / deathmatch starts.
THING_P1 = 1
THING_P2 = 2
THING_P3 = 3
THING_P4 = 4
THING_DM = 11

# Each player-start thing type is labelled with a single lowercase English
# word (matching the "normal"/"secret"/"viewport" style already used for
# doors). The final key is prefixed with the map name, e.g. "E1M1-normal".
PLAYER_TYPES = {
    THING_P1: "normal",
    THING_P2: "partner",
    THING_P3: "ally",
    THING_P4: "buddy",
}

# DOOM 1 map-name pattern (ExMy) and DOOM 2 pattern (MAPxx) — we accept both
# so the script also works on non-shareware WADs dropped in later.
MAP_NAME_RE = re.compile(r"^(E\dM\d|MAP\d{2})$")


def read_wad_directory(data):
    """Parse a WAD header + directory. Returns (identification, [(name, off, size), ...])."""
    if len(data) < 12:
        raise ValueError("file too small to be a WAD")
    ident, numlumps, infotableofs = struct.unpack_from("<4sII", data, 0)
    ident = ident.decode("ascii", errors="replace")
    if ident not in ("IWAD", "PWAD"):
        raise ValueError(f"not a WAD file (identification={ident!r})")

    entries = []
    for i in range(numlumps):
        off, size, raw_name = struct.unpack_from("<II8s", data, infotableofs + i * 16)
        name = raw_name.rstrip(b"\x00").decode("ascii", errors="replace")
        entries.append((name, off, size))
    return ident, entries


def find_things_lump_for_map(entries, map_name):
    """Given the directory, locate the THINGS lump that belongs to `map_name`.

    Map data in a WAD is laid out as a zero-length marker lump named after the
    map, followed by a fixed run of sub-lumps (THINGS, LINEDEFS, ...). We just
    take the first THINGS lump that appears after the marker.
    """
    for i, (name, _, _) in enumerate(entries):
        if name != map_name:
            continue
        for j in range(i + 1, min(i + 11, len(entries))):
            sub_name, off, size = entries[j]
            if sub_name == "THINGS":
                return off, size
        return None
    return None


def parse_things(data, off, size):
    """Yield (x, y, angle_deg, type, flags) tuples from a THINGS lump."""
    # Each DOOM 1/2 thing record is 10 bytes: x, y, angle, type, flags (all int16/uint16 LE).
    record_size = 10
    if size % record_size != 0:
        raise ValueError(f"THINGS lump size {size} is not a multiple of {record_size}")
    count = size // record_size
    for i in range(count):
        x, y, angle, ttype, flags = struct.unpack_from(
            "<hhhHH", data, off + i * record_size
        )
        yield x, y, angle, ttype, flags


def extract_starts_for_map(wad_data, entries, map_name):
    """Return an OrderedDict of "{map_name}-{label}" -> {x, y, rotation}
    for every player/deathmatch start in the named map."""
    loc = find_things_lump_for_map(entries, map_name)
    if loc is None:
        return None
    off, size = loc

    starts = OrderedDict()
    dm_spots = []

    for x, y, angle, ttype, _ in parse_things(wad_data, off, size):
        entry = {"x": x, "y": y, "rotation": angle}
        if ttype in PLAYER_TYPES:
            starts[PLAYER_TYPES[ttype]] = entry
        elif ttype == THING_DM:
            dm_spots.append(entry)

    # Stable order: P1..P4 labels first, then dm1, dm2, ...; keys prefixed
    # with the map name so they share the namespace with existing doors.
    ordered = OrderedDict()
    for label in ("normal", "partner", "ally", "buddy"):
        if label in starts:
            ordered[f"{map_name}-{label}"] = starts[label]
    for idx, spot in enumerate(dm_spots, start=1):
        ordered[f"{map_name}-dm{idx}"] = spot
    return ordered


def map_name_from_json_filename(fname):
    base = os.path.splitext(os.path.basename(fname))[0]
    return base if MAP_NAME_RE.match(base) else None


def update_level_json(json_path, starts, dry_run=False):
    with open(json_path, "r") as fh:
        level = json.load(fh, object_pairs_hook=OrderedDict)

    # Strip stale entries from previous naming schemes. Earlier versions of
    # this script wrote P1_start..P4_start and DM_1..DM_N either at the top
    # level or nested under "doors"; clean both up before inserting the new
    # prefixed labels so re-running is idempotent.
    def _is_stale(key):
        return (
            key in ("P1_start", "P2_start", "P3_start", "P4_start")
            or key.startswith("DM_")
        )

    for key in list(level.keys()):
        if _is_stale(key):
            del level[key]
    existing_doors = level.get("doors")
    if isinstance(existing_doors, dict):
        for key in list(existing_doors.keys()):
            if _is_stale(key):
                del existing_doors[key]

    doors = level.setdefault("doors", OrderedDict())
    for key, value in starts.items():
        doors[key] = value

    if dry_run:
        print(f"-- {json_path} --")
        print(json.dumps({"doors": doors}, indent=4))
        return

    with open(json_path, "w") as fh:
        json.dump(level, fh, indent=4)
        fh.write("\n")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wad", default="doom1.wad", help="path to the WAD file")
    parser.add_argument(
        "--dir",
        default=".",
        help="directory containing level JSON files (default: cwd)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="print the extracted starts instead of writing JSON files",
    )
    args = parser.parse_args(argv)

    with open(args.wad, "rb") as fh:
        wad_data = fh.read()

    _, entries = read_wad_directory(wad_data)

    json_files = sorted(
        os.path.join(args.dir, f)
        for f in os.listdir(args.dir)
        if f.endswith(".json") and map_name_from_json_filename(f)
    )
    if not json_files:
        print(f"no level JSON files found in {args.dir}", file=sys.stderr)
        return 1

    for path in json_files:
        map_name = map_name_from_json_filename(path)
        starts = extract_starts_for_map(wad_data, entries, map_name)
        if starts is None:
            print(f"warning: map {map_name} not found in {args.wad}", file=sys.stderr)
            continue
        update_level_json(path, starts, dry_run=args.dry_run)
        summary = ", ".join(starts.keys())
        print(f"{map_name}: {summary}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
