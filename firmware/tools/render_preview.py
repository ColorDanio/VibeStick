#!/usr/bin/env python3
"""Render VibeStick firmware screens to PNGs using the EXACT font data and
layout logic of the firmware (16px surfaces), for visual verification.

Loads firmware/src/assets/cjk_font.h, reimplements the 16px text pipeline
(utf-8 codepoints, 8/16 px cells, pixel wrap) and the screen layouts of
home / session picker / conversation / transcript.

Output: /tmp/preview_{home,picker,convo,transcript}.png (3x scale)
"""

import re

from PIL import Image, ImageDraw

SCALE = 3
W, H = 240, 135

SRC = open("firmware/src/assets/cjk_font.h").read()


def extract(name):
    m = re.search(name + r"\[[\d\s]*\] = \{(.*?)\};", SRC, re.S)
    return [int(x, 16) for x in re.findall(r"0x([0-9A-Fa-f]+)", m.group(1))]


ASCII_G = extract("cjk_ascii_glyphs")
INDEX = extract("cjk_hanzi_index")
HANZI_G = extract("cjk_hanzi_glyphs")

WHITE = (255, 255, 255)
DIM = (123, 239, 123)      # ~COL_DIM light grey
FAINT = (90, 90, 90)
BLACK = (0, 0, 0)
CYAN = (0, 255, 255)
GREEN = (0, 255, 0)
AMBER = (255, 190, 0)
RED = (255, 0, 0)
BLUE = (0, 0, 255)
HL = (16, 30, 68)          # COL_HL dark steel blue


def hanzi_index(cp):
    lo, hi = 0, len(INDEX) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        if INDEX[mid] == cp:
            return mid
        if INDEX[mid] < cp:
            lo = mid + 1
        else:
            hi = mid - 1
    return -1


def cp_width(cp):
    if cp < 0x20:
        return 0
    if cp < 0x7F:
        return 8
    return 16 if hanzi_index(cp) >= 0 else 8


def text_width(s):
    return sum(cp_width(ord(c)) for c in s)


def glyph_rows(cp):
    if cp < 0x7F:
        off = (cp - 0x20) * 16
        return ASCII_G[off:off + 16], 8
    i = hanzi_index(cp)
    if i < 0:
        off = (ord("?") - 0x20) * 16
        return ASCII_G[off:off + 16], 8
    rows = []
    for r in range(16):
        rows.append(HANZI_G[i * 32 + r * 2])
        rows.append(HANZI_G[i * 32 + r * 2 + 1])
    return rows, 16


def draw_text16(img, x, y, s, color, max_w=232):
    """Render s into img at (x, y) with firmware glyph semantics; returns width."""
    max_w = min(max_w, W - x)
    w = 0
    for ch in s:
        cw = cp_width(ord(ch))
        if cw == 0:
            continue
        if w + cw > max_w:
            break
        w += cw
    cx = 0
    px = img.load()
    for ch in s:
        cp = ord(ch)
        if cp < 0x20:
            continue
        rows, gw = glyph_rows(cp)
        if cx + gw > w:
            break
        for row in range(16):
            if gw == 8:
                bits = rows[row]
                for col in range(8):
                    if bits & (0x80 >> col):
                        px[x + cx + col, y + row] = color
            else:
                b0, b1 = rows[row * 2], rows[row * 2 + 1]
                for col in range(16):
                    b = b0 if col < 8 else b1
                    if b & (0x80 >> (col % 8)):
                        px[x + cx + col, y + row] = color
        cx += gw
    return w


def wrap16(s, max_w):
    """Firmware drawWrapped16: greedy pixel wrap, returns list of lines."""
    lines = []
    cur = s
    while cur:
        w = 0
        end = 0
        for i, ch in enumerate(cur):
            cw = cp_width(ord(ch))
            if w + cw > max_w:
                break
            w += cw
            end = i + 1
        if end == 0:
            break
        lines.append(cur[:end])
        cur = cur[end:]
    return lines


def small(img, x, y, s, color):
    """6 px chrome text (PIL default bitmap font ~8px)."""
    ImageDraw.Draw(img).text((x, y), s, fill=color)


def screen():
    return Image.new("RGB", (W, H), BLACK)


def status_bar(img):
    d = ImageDraw.Draw(img)
    d.rectangle([222, 0, 238, 16], outline=WHITE)  # battery placeholder
    d.rectangle([2, 0, 18, 16], outline=CYAN)      # bt placeholder
    d.line([0, 15, W, 15], fill=FAINT)
    small(img, W - 50, 4, "100%", DIM)


def frame(img, x, y, w, h, outline=CYAN):
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([x, y, x + w, y + h], radius=8, fill=HL, outline=outline)


def dot(img, x, y, r, color):
    ImageDraw.Draw(img).ellipse([x - r, y - r, x + r, y + r], fill=color)


def preview_home():
    img = screen()
    status_bar(img)
    cx = W // 2
    frame(img, cx - 28, 26, 56, 56)
    ImageDraw.Draw(img).rectangle([cx - 12, 36, cx + 12, 60], outline=WHITE)
    name = "Claude Code"
    draw_text16(img, (W - text_width(name)) // 2, 90, name, WHITE)
    dot(img, 96, 118, 4, GREEN)
    small(img, 104, 114, "running", GREEN)
    for i, c in enumerate([CYAN, FAINT, FAINT, FAINT]):
        dot(img, 108 + i * 10, 130, 2, c)
    return img


def preview_picker():
    img = screen()
    status_bar(img)
    small(img, 4, 20, "kimi-cli@vibestick ~ %", GREEN)
    rows = [
        (0, "+ new session", None, False),
        (1, "修复登录跳转问题", "running", True),
        (2, "refactor-api-and-cleanup", "idle", False),
        (3, "《协议》v2.1 评审：数据库层", "ready", True),
    ]
    y = 36
    for _, name, st, fg in rows:
        if st:
            color = RED if st in ("running", "error") else GREEN if fg or st == "ready" else FAINT
            dot(img, 18, y + 8, 3, color)
            draw_text16(img, 28, y, name, WHITE, max_w=W - 36)
        else:
            draw_text16(img, 16, y, name, DIM, max_w=W - 24)
        y += 18
    return img


def convo_chrome(img, sess, state, busy):
    status_bar(img)
    d = ImageDraw.Draw(img)
    dot(img, 12, 27, 4, RED if busy else BLUE)
    draw_text16(img, 24, 20, sess, GREEN, max_w=W - 24 - 10 - 62)
    bw = len(state) * 6 + 8
    d.rounded_rectangle([W - 6 - bw, 20, W - 6, 34], radius=3, outline=GREEN)
    small(img, W - 6 - bw + 4, 23, state, GREEN)
    d.line([0, 38, W, 38], fill=FAINT)
    small(img, 4, 44, "ctx", FAINT)
    d.rectangle([24, 43, 88, 52], outline=DIM)
    d.rectangle([25, 44, 25 + 26, 51], fill=GREEN)
    small(img, 92, 44, "42%", WHITE)
    small(img, W - 40, 44, "$1.23", AMBER)
    d.line([0, foot_div_y(), W, foot_div_y()], fill=FAINT)


def landscape():
    return W > H


def foot_div_y():
    return H - (19 if landscape() else 30)


def foot_l1_y():
    return H - (10 if landscape() else 21)


def foot_l2_y():
    return H - 13


def hint_button(img, x, y, key, color=FAINT):
    d = ImageDraw.Draw(img)
    d.ellipse([x - 7, y - 7, x + 7, y + 7], outline=color)
    small(img, x - 3, y - 4, key, color)


def hint_hold_a(img, x, y):
    d = ImageDraw.Draw(img)
    d.ellipse([x - 7, y - 7, x + 7, y + 7], fill=WHITE)
    small(img, x - 3, y - 4, "A", BLACK)


def hint_arrow(img, x, y, right, color=FAINT):
    d = ImageDraw.Draw(img)
    d.polygon([(x + 5, y), (x - 3, y - 5), (x - 3, y + 5)] if right
              else [(x - 5, y), (x + 3, y - 5), (x + 3, y + 5)], fill=color)


def hint_mic(img, x, y, color=FAINT):
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([x - 3, y - 7, x + 3, y + 3], radius=3, outline=color)
    d.line([x, y + 3, x, y + 7], fill=color)
    d.line([x - 4, y + 7, x + 5, y + 7], fill=color)


def footer_hints(img, mode):
    y = foot_l1_y()
    d = ImageDraw.Draw(img)
    if mode == "page":
        hint_button(img, 12, y, "A"); hint_arrow(img, 25, y, False)
        hint_button(img, 48, y, "B"); hint_arrow(img, 61, y, True)
        hint_hold_a(img, W - 31, y)
        hint_mic(img, W - 12, y)
    elif mode == "busy":
        x = W - 45
        hint_button(img, x, y, "A", RED)
        d.rectangle([x + 10, y - 5, x + 20, y + 5], fill=RED)
        hint_mic(img, W - 12, y, AMBER)


def footer_thinking(img):
    y = foot_l1_y()
    d = ImageDraw.Draw(img)
    d.polygon([(5, y + 7), (11, y + 7), (8, y + 1)], fill=AMBER)
    small(img, 16, y, "thinking...", AMBER)
    footer_hints(img, "busy")


def preview_convo():
    img = screen()
    convo_chrome(img, "修复登录跳转问题", "running", busy=False)
    tail = "user: 修复登录跳转的问题，顺便看看《权限校验》这块：边界条件、超时重试、还有 session 过期后的重定向……"
    y = 52
    max_lines = (foot_div_y() - 12 - y) // 18
    for line in wrap16(tail, W - 8)[:max_lines]:
        draw_text16(img, 4, y, line, AMBER)
        y += 18
    small(img, W - 32, foot_div_y() - 10, "1/3", FAINT)
    footer_thinking(img)
    return img


def preview_page():
    img = screen()
    convo_chrome(img, "修复登录跳转问题", "idle", busy=False)
    tail = "assistant: 已完成检查，A 看更早内容，B 看更新内容。"
    y = 52
    max_lines = (foot_div_y() - 12 - y) // 18
    for line in wrap16(tail, W - 8)[:max_lines]:
        draw_text16(img, 4, y, line, GREEN)
        y += 18
    small(img, W - 32, foot_div_y() - 10, "1/3", FAINT)
    footer_hints(img, "page")
    return img


def preview_transcript():
    img = screen()
    convo_chrome(img, "fix-auth-bug", "idle", busy=False)
    dot(img, 12, 27, 4, BLUE)  # ready = blue
    text = "looks good, please continue with the refactoring and add integration tests for the login flow"
    y = 52
    max_lines = (foot_div_y() - 12 - y) // 18
    for line in wrap16(text, W - 8)[:max_lines]:
        draw_text16(img, 4, y, line, GREEN)
        y += 18
    y = foot_l1_y()
    hint_button(img, W - 45 if landscape() else 12, y, "A", AMBER)
    ImageDraw.Draw(img).polygon([(W - 23 if landscape() else 34, y),
                                  (W - 35 if landscape() else 22, y - 6),
                                  (W - 35 if landscape() else 22, y + 6)], fill=AMBER)
    hint_mic(img, W - 12, y)
    return img


def set_size(width, height):
    global W, H
    W, H = width, height


def main():
    for orientation, size in (("landscape", (240, 135)), ("portrait", (135, 240))):
        set_size(*size)
        outs = {
            f"session_picker_{orientation}": preview_picker(),
            f"session_convo_page_{orientation}": preview_page(),
            f"session_convo_running_{orientation}": preview_convo(),
            f"session_convo_ready_{orientation}": preview_transcript(),
        }
        for name, img in outs.items():
            big = img.resize((W * SCALE, H * SCALE), Image.NEAREST)
            path = f"/tmp/preview_{name}.png"
            big.save(path)
            print(path)


if __name__ == "__main__":
    main()
