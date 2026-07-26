#!/usr/bin/env python3
"""Generate firmware/src/assets/icons.h from ASCII art.

Each icon is defined as a grid of characters; the palette maps characters
to 16-bit RGB565 colors. '.' is fully transparent (drawn via pushImage's
transparent-color overload, sentinel TRANSPARENT below).

Regenerate with:  python3 firmware/tools/gen_icons.py
"""

import os

# RGB565 palette
PAL = {
    "W": 0xFFFF,  # white
    "g": 0x7BEF,  # light grey
    "d": 0x4208,  # dark grey
    "R": 0xF800,  # red
    "O": 0xFD20,  # orange
    "Y": 0xFFE0,  # yellow
    "G": 0x07E0,  # green
    "C": 0x07FF,  # cyan
    "B": 0x3D9F,  # mid blue
    "P": 0x781F,  # purple
}
TRANSPARENT = 0xF81F  # magenta sentinel, never used in art

# ---------------------------------------------------------------- 24x24 ---

ICON_TOOL = [
    "........................",
    "...ggg..................",
    "..g...gg................",
    "..g....gg...............",
    "..g.....gg..............",
    "..g......gg.............",
    "...ggggggggg............",
    "...........ggg..........",
    "............ggg.........",
    ".............ggg........",
    "..............ggg.......",
    "...............ggg......",
    "................ggg.....",
    ".................ggg....",
    "..................ggg...",
    "...................ggg..",
    "............ggg....ggg..",
    "...........g...g...gg...",
    "...........g....g.ggg...",
    "...........g....ggg.....",
    "............g..ggg......",
    ".............ggg........",
    "........................",
    "........................",
]

# Vibe Mic: one white capsule with two restrained cyan sound-wave strokes.
# Deliberately no enclosing ring: agent CLI marks are open, sparse symbols.
ICON_VIBE_MIC24 = [
    "........................",
    "........WWWWWWWW........",
    ".......WW......WW.......",
    ".......W........W.......",
    "..CC...W........W...CC..",
    "...CC..W........W..CC...",
    "....CC.W........W.CC....",
    "....CC.W........W.CC....",
    "...CC..W........W..CC...",
    "..CC...WW......WW...CC..",
    ".......WWWWWWWW.........",
    "..........WW............",
    "........WWWWWW..........",
    "........................",
    "........................",
    "........................",
    "........................",
    "........................",
    "........................",
    "........................",
    "........................",
    "........................",
    "........................",
    "........................",
]

# YOLO: cyan prompt/cursor plus a small green forward-send arrow.  This
# reads as "speak to the current cursor" without a generic terminal box.
ICON_YOLO24 = [
    "........................",
    "........................",
    "........................",
    "....CC..................",
    ".....CC.................",
    "......CC................",
    ".......CC...............",
    "......CC................",
    ".....CC......GG.........",
    "....CC......GGGG........",
    "...........GGGGGG.......",
    ".............GGGG.......",
    "..............GG........",
    "........................",
    "........................",
    "........................",
    "........................",
    "........................",
    "........................",
    "........................",
    "........................",
    "........................",
    "........................",
    "........................",
]

# ---------------------------------------------------------------- 16x16 ---

# Bar chart
ICON_STATUS = [
    "................",
    ".............GG.",
    ".............GG.",
    ".........YY..GG.",
    ".........YY..GG.",
    ".....CC..YY..GG.",
    ".....CC..YY..GG.",
    ".WW..CC..YY..GG.",
    ".WW..CC..YY..GG.",
    ".WW..CC..YY..GG.",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
]

# List of sessions
ICON_SESSIONS = [
    "................",
    "..OO..WWWWWWWW..",
    "..OO..WWWWWWWW..",
    "................",
    "..gg..WWWWWWWW..",
    "..gg..WWWWWWWW..",
    "................",
    "..gg..WWWWWWWW..",
    "..gg..WWWWWWWW..",
    "................",
    "..gg..WWWWWWWW..",
    "..gg..WWWWWWWW..",
    "................",
    "................",
    "................",
    "................",
]

# Microphone
ICON_VOICE = [
    ".....WWWWW......",
    "....WW...WW.....",
    "....W.....W.....",
    "....W.....W.....",
    "....W.....W.....",
    "....W.....W.....",
    "....W.....W.....",
    "....WW...WW.....",
    ".WW..WWWWW..WW..",
    ".W...........W..",
    ".W...........W..",
    "..W.........W...",
    "...WW.....WW....",
    "......WWW.......",
    "......WWW.......",
    "....WWWWWWW.....",
]

# Return arrow (enter)
ICON_ENTER = [
    "................",
    ".........W......",
    ".........W......",
    ".........W......",
    "...W.....W......",
    "...WW....W......",
    "...WWWWWWWWWW...",
    "...WWWWWWWWWW...",
    "...WW...........",
    "...W............",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
]

# Escape: red X
ICON_ESCAPE = [
    "................",
    "..RR.......RR...",
    "...RR.....RR....",
    "....RR...RR.....",
    ".....RR.RR......",
    "......RRR.......",
    "......RRR.......",
    ".....RR.RR......",
    "....RR...RR.....",
    "...RR.....RR....",
    "..RR.......RR...",
    "................",
    "................",
    "................",
    "................",
    "................",
]

# Custom key binding: key cap with star
ICON_KEY = [
    "................",
    ".WWWWWWWWWWWWWW.",
    ".W............W.",
    ".W....WWWW....W.",
    ".W...WW..WW...W.",
    ".W....WWWW....W.",
    ".W.....WW.....W.",
    ".W...WWWWWW...W.",
    ".W..WW.WW.WW..W.",
    ".W....WWWW....W.",
    ".W............W.",
    ".WWWWWWWWWWWWWW.",
    "................",
    "................",
    "................",
    "................",
]

def _battery(fill_cols, color):
    """Battery outline (white) + tip; fill_cols inner columns filled."""
    rows = [list(r) for r in [
        "................",
        "................",
        "...WWWWWWWWWW...",
        "..W..........WW.",
        "..W...........W.",
        "..W...........W.",
        "..W...........W.",
        "..W...........W.",
        "..W...........W.",
        "..W...........W.",
        "..W..........WW.",
        "...WWWWWWWWWW...",
        "................",
        "................",
        "................",
        "................",
    ]]
    for r in range(4, 10):
        for c in range(3, 3 + fill_cols):
            rows[r][c] = color
    return ["".join(r) for r in rows]

ICONS = [
    # name, art, size
    ("icon_tool", ICON_TOOL, 24),
    ("icon_vibe_mic24", ICON_VIBE_MIC24, 24),
    ("icon_yolo24", ICON_YOLO24, 24),

    ("icon_status", ICON_STATUS, 16),
    ("icon_sessions", ICON_SESSIONS, 16),
    ("icon_voice", ICON_VOICE, 16),
    ("icon_enter", ICON_ENTER, 16),
    ("icon_escape", ICON_ESCAPE, 16),
    ("icon_key", ICON_KEY, 16),

    ("icon_bat_0", _battery(0, "R"), 16),
    ("icon_bat_1", _battery(3, "R"), 16),
    ("icon_bat_2", _battery(6, "Y"), 16),
    ("icon_bat_3", _battery(9, "G"), 16),
]

def emit(name, art, size):
    assert len(art) == size, f"{name}: {len(art)} rows != {size}"
    px = []
    for row in art:
        assert len(row) == size, f"{name}: bad row width: '{row}'"
        for ch in row:
            px.append(TRANSPARENT if ch == "." else PAL[ch])
    lines = [f"static const uint16_t {name}[{size * size}] = {{"]
    for i in range(0, len(px), size):
        lines.append("  " + ",".join(f"0x{v:04X}" for v in px[i:i + size]) + ",")
    lines.append("};")
    return "\n".join(lines)

def main():
    out = [
        "// AUTO-GENERATED by firmware/tools/gen_icons.py -- do not edit by hand.",
        "// 16-bit RGB565 bitmaps; draw with:",
        "//   M5.Lcd.pushImage(x, y, W, H, icon, ICON_TRANSPARENT);",
        "#pragma once",
        "",
        "#include <stdint.h>",
        "",
        "#define ICON_TRANSPARENT 0xF81F",
        "",
    ]
    for name, art, size in ICONS:
        out.append(emit(name, art, size))
        out.append("")
    path = os.path.join(os.path.dirname(__file__), "..", "src", "assets", "icons.h")
    path = os.path.normpath(path)
    with open(path, "w") as f:
        f.write("\n".join(out))
    print(f"wrote {path} ({len(ICONS)} icons)")

if __name__ == "__main__":
    main()
