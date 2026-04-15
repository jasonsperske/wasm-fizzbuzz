#!/usr/bin/env python3
"""
Read every per-level JSON file (E1M1.json, E1M2.json, ...) and emit a single
flat list of door descriptors in this shape:

    [
        {
            "game_door_id": "E1M1-normal",
            "label": "Normal",
            "dest_url": "https://jasonsperske.github.io/doom/E1M1/E1M1-normal.html"
        },
        ...
    ]

Every entry under each level's `doors` object becomes one item. The label is
the title-cased suffix (the part after the "ExMy-" prefix). The dest_url
embeds the full door key as the page name.

Usage:
    python3 build_doors_list.py [--dir .] [--output doors.json]

With no --output the JSON is written to stdout.
"""

import argparse
import json
import os
import re
import sys

DEST_URL_TEMPLATE = "https://jasonsperske.github.io/doom/{map}/{door}.html"

# Match either DOOM 1 (ExMy) or DOOM 2 (MAPxx) map filenames.
MAP_NAME_RE = re.compile(r"^(E\dM\d|MAP\d{2})$")


def map_name_from_filename(fname):
    base = os.path.splitext(os.path.basename(fname))[0]
    return base if MAP_NAME_RE.match(base) else None


def suffix_for(door_key, map_name):
    """Strip the "ExMy-" prefix from a door key to get the bare label part.

    Falls back to the full key if the prefix is missing, so doors that don't
    follow the convention still produce a sensible label.
    """
    prefix = f"{map_name}-"
    if door_key.startswith(prefix):
        return door_key[len(prefix):]
    return door_key


# "dm1" -> "Deathmatch 1", "dm10" -> "Deathmatch 10", etc.
DM_SUFFIX_RE = re.compile(r"^dm(\d+)$", re.IGNORECASE)


def humanize_suffix(suffix):
    """Convert a door-key suffix into a human-readable label."""
    match = DM_SUFFIX_RE.match(suffix)
    if match:
        return f"Deathmatch {int(match.group(1))}"
    return suffix.title()


def build_door_entries(level_path):
    map_name = map_name_from_filename(level_path)
    if not map_name:
        return []

    with open(level_path, "r") as fh:
        level = json.load(fh)

    doors = level.get("doors") or {}
    entries = []
    for door_key in doors:
        suffix = suffix_for(door_key, map_name)
        entries.append(
            {
                "game_door_id": door_key,
                "label": humanize_suffix(suffix),
                "dest_url": DEST_URL_TEMPLATE.format(map=map_name, door=door_key),
            }
        )
    return entries


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dir",
        default=".",
        help="directory containing level JSON files (default: cwd)",
    )
    parser.add_argument(
        "--output",
        help="write JSON to this path instead of stdout",
    )
    args = parser.parse_args(argv)

    json_paths = sorted(
        os.path.join(args.dir, f)
        for f in os.listdir(args.dir)
        if f.endswith(".json") and map_name_from_filename(f)
    )
    if not json_paths:
        print(f"no level JSON files found in {args.dir}", file=sys.stderr)
        return 1

    all_entries = []
    for path in json_paths:
        all_entries.extend(build_door_entries(path))

    payload = json.dumps(all_entries, indent=2) + "\n"
    if args.output:
        with open(args.output, "w") as fh:
            fh.write(payload)
        print(f"wrote {len(all_entries)} doors to {args.output}", file=sys.stderr)
    else:
        sys.stdout.write(payload)
    return 0


if __name__ == "__main__":
    sys.exit(main())
