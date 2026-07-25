#include "ui.h"

#include "board.h"

#include "assets/cjk_font.h"
#include "assets/icons.h"
#include "assets/logos.h"
#include "ble.h"

#define BAR_H 16

#define COL_ACCENT 0x07FF      // cyan
#define COL_HL 0x10E2          // highlight row background (dark steel blue)
#define COL_DIM 0x7BEF         // light grey
#define COL_FAINT 0x4208       // dark grey
#define COL_GREEN 0x07E0       // terminal green
#define COL_AMBER 0xFBE0       // terminal amber

static int sW = 240;  // cached screen size, updated by uiSetOrientation
static int sH = 135;
static int sBatteryPct = -1;

void uiSetOrientation(uint8_t rot) {
  M5Lcd.setRotation(rot);
  sW = M5Lcd.width();
  sH = M5Lcd.height();
}

void uiSetBatteryPct(int pct) { sBatteryPct = pct; }

static bool landscape() { return sW > sH; }

static uint16_t stateColor(const char* state) {
  if (strcmp(state, "running") == 0) return TFT_GREEN;
  if (strcmp(state, "ready") == 0) return TFT_GREEN;
  if (strcmp(state, "waiting") == 0) return TFT_YELLOW;
  if (strcmp(state, "error") == 0) return TFT_RED;
  return COL_DIM;  // idle / unknown
}

// Text size 1 = 6 px/char, size 2 = 12 px/char.
static int charsFit(int widthPx, int size) {
  int n = widthPx / (6 * size);
  return n < 0 ? 0 : n;
}

static void centerText(const char* s, int y, int size, uint16_t color) {
  int w = strlen(s) * 6 * size;
  int x = (sW - w) / 2;
  if (x < 0) x = 0;
  M5Lcd.setTextSize(size);
  M5Lcd.setTextColor(color, TFT_BLACK);
  M5Lcd.setCursor(x, y);
  M5Lcd.print(s);
}

// The built-in GLCD font covers Latin-1 only; anything outside printable
// ASCII is substituted with '?' in small (6 px) text paths. CJK content
// goes through the 16 px rich-text renderer below instead.
static void lcdPrintClean(const char* p, int n) {
  for (int i = 0; i < n; ++i) {
    uint8_t c = (uint8_t)p[i];
    M5Lcd.print((c >= 32 && c <= 126) ? (char)c : '?');
  }
}

// ---- 16 px rich text: ASCII half-width (8 px) + CJK full-width (16 px) --
// UTF-8 decoded per codepoint; hanzi looked up in the generated GB2312
// level-1 bitmap font (assets/cjk_font.h). Unknown codepoints -> '?'.

// Decode one UTF-8 codepoint and advance the pointer.
static uint32_t utf8Next(const char** pp) {
  const uint8_t* p = (const uint8_t*)*pp;
  uint32_t cp;
  if (p[0] < 0x80) {
    cp = p[0];
    *pp += 1;
  } else if ((p[0] & 0xE0) == 0xC0 && (p[1] & 0xC0) == 0x80) {
    cp = ((p[0] & 0x1F) << 6) | (p[1] & 0x3F);
    *pp += 2;
  } else if ((p[0] & 0xF0) == 0xE0 && (p[1] & 0xC0) == 0x80 &&
             (p[2] & 0xC0) == 0x80) {
    cp = ((p[0] & 0x0F) << 12) | ((p[1] & 0x3F) << 6) | (p[2] & 0x3F);
    *pp += 3;
  } else if ((p[0] & 0xF8) == 0xF0 && (p[1] & 0xC0) == 0x80 &&
             (p[2] & 0xC0) == 0x80 && (p[3] & 0xC0) == 0x80) {
    cp = ((p[0] & 0x07) << 18) | ((p[1] & 0x3F) << 12) |
         ((p[2] & 0x3F) << 6) | (p[3] & 0x3F);
    *pp += 4;
  } else {
    cp = 0xFFFD;  // invalid byte: skip one, show fallback
    *pp += 1;
  }
  return cp;
}

// Binary search in the sorted hanzi index; -1 when not covered.
static int hanziIndex(uint32_t cp) {
  if (cp > 0xFFFF) return -1;
  int lo = 0, hi = CJK_FONT_HANZI_COUNT - 1;
  while (lo <= hi) {
    int mid = (lo + hi) / 2;
    uint16_t v = cjk_hanzi_index[mid];
    if (v == cp) return mid;
    if (v < cp) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

// Display width of one codepoint in px (control chars take no space).
static int cpWidth16(uint32_t cp) {
  if (cp < 0x20) return 0;
  if (cp < 0x7F) return 8;
  return hanziIndex(cp) >= 0 ? 16 : 8;  // unknowns render as '?'
}

static int textWidth16(const char* s) {
  int w = 0;
  const char* p = s;
  while (*p) w += cpWidth16(utf8Next(&p));
  return w;
}

#define TEXT16_MAX_W 240
static uint16_t sLineBuf[TEXT16_MAX_W * 16];

// Rasterize up to nBytes of s into the line buffer and push in one SPI
// transfer, clipped to maxW px. Returns the drawn width.
static int drawText16N(int x, int y, const char* s, int nBytes, uint16_t color,
                       uint16_t bg, int maxW) {
  int w = 0;
  {
    // Pre-pass: how many bytes' worth of whole glyphs fit into maxW px.
    // Decode into a TEMP pointer first -- advancing before the fit check
    // would include a glyph whose pixels exceed the line stride (the
    // CJK-round regression: wrapped/overlapping text).
    const char* p = s;
    const char* end = s + nBytes;
    while (p < end && *p) {
      const char* t = p;
      int cw = cpWidth16(utf8Next(&t));
      if (w + cw > maxW) break;
      w += cw;
      p = t;
    }
    nBytes = (int)(p - s);
  }
  if (w <= 0) return 0;
  for (int i = 0; i < w * 16; ++i) sLineBuf[i] = bg;
  int cx = 0;
  const char* p = s;
  const char* end = s + nBytes;
  while (p < end && *p) {
    uint32_t cp = utf8Next(&p);
    if (cp < 0x20) continue;
    int idx = (cp < 0x7F) ? (int)cp - 0x20 : hanziIndex(cp);
    bool wide = idx >= 0 && cp >= 0x7F;
    if (idx < 0) idx = '?' - 0x20;  // ASCII fallback glyph
    const uint8_t* g = wide ? cjk_hanzi_glyphs + idx * 32
                            : cjk_ascii_glyphs + idx * 16;
    int gw = wide ? 16 : 8;
    if (cx + gw > w) break;  // never write past the line stride
    for (int row = 0; row < 16; ++row) {
      for (int col = 0; col < gw; ++col) {
        if (g[row * (wide ? 2 : 1) + col / 8] & (0x80 >> (col % 8)))
          sLineBuf[row * w + cx + col] = color;
      }
    }
    cx += gw;
  }
  M5Lcd.pushImage(x, y, w, 16, sLineBuf);
  return w;
}

static int drawText16(int x, int y, const char* s, uint16_t color,
                      uint16_t bg) {
  return drawText16N(x, y, s, strlen(s), color, bg, TEXT16_MAX_W);
}


// Draw at most maxLines pixel-wrapped lines of s at (x, y), line pitch 18.
// Returns the number of lines used; appends "..." when truncated.
static int drawWrapped16(int x, int y, const char* s, int maxW, int maxLines,
                         uint16_t color) {
  const char* cur = s;
  int lines = 0;
  while (*cur && lines < maxLines) {
    const char* q = cur;
    const char* end = cur;
    int w = 0;
    while (*q) {
      const char* t = q;
      int cw = cpWidth16(utf8Next(&t));
      if (w + cw > maxW) break;
      w += cw;
      q = t;
      end = q;
    }
    if (end == cur) break;  // can't fit a single glyph
    int used = drawText16N(x, y, cur, (int)(end - cur), color, TFT_BLACK, maxW);
    cur = end;
    ++lines;
    if (*cur && lines == maxLines) {  // truncated
      drawText16(x + used + 2, y, "...", COL_DIM, TFT_BLACK);
    }
    y += 18;
  }
  return lines;
}

// ---- Marquee: horizontal scroll for text that doesn't fit ----
// Non-blocking: drawMarquee() renders the current offset, uiMarqueeTick()
// (called from loop()) advances time-based phases and redraws ONLY the
// affected text band. Cycle: hold ~1s at start -> scroll left ~1 char/90ms
// -> hold ~0.7s at end -> small blank gap -> jump back to start.

#define MQ_HOLD_START_MS 1000
#define MQ_TICK_MS 90
#define MQ_HOLD_END_MS 700
#define MQ_GAP_MS 350
#define MQ_STALE_MS 1200  // slot not drawn for this long -> deactivate

enum MqSlot {
  MQ_HOME_NAME = 0,
  MQ_SESSION_ROW,
  MQ_CONVO_HDR,
  MQ_TRANSCRIPT,
  MQ_SLOTS
};

struct Marquee {
  const char* text = nullptr;  // compared by pointer AND content
  uint32_t nextAt = 0;
  uint32_t lastDrawAt = 0;
  int offset = 0;
  int maxOff = 0;
  uint8_t phase = 0;  // 0 hold-start, 1 scroll, 2 hold-end, 3 gap
  bool active = false;
  bool big = false;   // 16 px rich text (widthChars = window px, offset = cps)
  // band geometry for direct partial redraws on ticks
  int16_t x = 0, y = 0;
  uint8_t widthChars = 0, size = 1;
  uint16_t color = 0, bg = 0;
};

static Marquee sMq[MQ_SLOTS];

// Count codepoints of s that fit into maxW px / in total.
static int cpsFitWidth16(const char* s, int maxW) {
  int w = 0, n = 0;
  const char* p = s;
  while (*p) {
    const char* t = p;
    int cw = cpWidth16(utf8Next(&t));
    if (w + cw > maxW) break;
    w += cw;
    p = t;
    ++n;
  }
  return n;
}

static int cpCount16(const char* s) {
  int n = 0;
  const char* p = s;
  while (*p) {
    utf8Next(&p);
    ++n;
  }
  return n;
}

// Erase and redraw only the marquee's own text band (never full-screen).
static void mqDrawBand(Marquee& m) {
  if (m.big) {
    // 16 px rich text: offset/maxOff are in codepoints, window in px.
    int fit = cpsFitWidth16(m.text, m.widthChars);
    int total = cpCount16(m.text);
    m.maxOff = total > fit ? total - fit : 0;
    if (m.offset > m.maxOff) {
      m.offset = 0;
      m.phase = 0;
    }
    M5Lcd.fillRect(m.x, m.y, m.widthChars, 18, m.bg);
    if (m.phase != 3) {
      const char* p = m.text;
      for (int i = 0; i < m.offset && *p; ++i) utf8Next(&p);
      drawText16N(m.x, m.y + 1, p, strlen(p), m.color, m.bg, m.widthChars);
    }
    m.lastDrawAt = millis();
    return;
  }
  // Defensive: the content buffer may have been rewritten shorter in place
  // (BLE push) since the offset was computed -- never read past the NUL.
  int len = strlen(m.text);
  if (m.offset > len - m.widthChars) {
    m.offset = 0;
    m.phase = 0;
    m.maxOff = len > m.widthChars ? len - m.widthChars : 0;
  }
  M5Lcd.fillRect(m.x, m.y, m.widthChars * 6 * m.size, 8 * m.size, m.bg);
  M5Lcd.setTextSize(m.size);
  M5Lcd.setTextColor(m.color, m.bg);
  M5Lcd.setCursor(m.x, m.y);
  if (m.phase == 3) {
    for (int i = 0; i < m.widthChars; ++i) M5Lcd.print(' ');
  } else {
    lcdPrintClean(m.text + m.offset, m.widthChars);
  }
  m.lastDrawAt = millis();
}

// Drop all slots (called on every screen switch so a tick can never paint
// a stale band over a different screen).
void uiMarqueeResetAll() {
  for (int i = 0; i < MQ_SLOTS; ++i) {
    sMq[i].active = false;
    sMq[i].text = nullptr;
  }
}

// Advance time-based phases; on movement, redraws ONLY the affected band.
void uiMarqueeTick() {
  uint32_t now = millis();
  for (int i = 0; i < MQ_SLOTS; ++i) {
    Marquee& m = sMq[i];
    if (!m.active) continue;
    if (now - m.lastDrawAt > MQ_STALE_MS) {  // screen switched away
      m.active = false;
      m.text = nullptr;
      continue;
    }
    if (now < m.nextAt) continue;
    switch (m.phase) {
      case 0:  // start hold done -> begin scrolling
        m.phase = 1;
        m.nextAt = now + MQ_TICK_MS;
        break;
      case 1:  // scrolling
        if (++m.offset >= m.maxOff) {
          m.offset = m.maxOff;
          m.phase = 2;
          m.nextAt = now + MQ_HOLD_END_MS;
        } else {
          m.nextAt = now + MQ_TICK_MS;
        }
        mqDrawBand(m);
        break;
      case 2:  // end hold done -> blank gap
        m.phase = 3;
        m.nextAt = now + MQ_GAP_MS;
        mqDrawBand(m);
        break;
      default:  // gap done -> back to start
        m.phase = 0;
        m.offset = 0;
        m.nextAt = now + MQ_HOLD_START_MS;
        mqDrawBand(m);
        break;
    }
  }
}

// Draw text clipped to a widthChars-wide window; scrolls when longer.
// Short text is drawn statically (padded with spaces to clear remnants).
static void drawMarquee(int slot, const char* text, int x, int y,
                        int widthChars, int size, uint16_t color,
                        uint16_t bg) {
  Marquee& m = sMq[slot];
  int len = strlen(text);

  if (len <= widthChars) {
    m.active = false;
    m.text = text;
    M5Lcd.setTextSize(size);
    M5Lcd.setTextColor(color, bg);
    M5Lcd.setCursor(x, y);
    M5Lcd.print(text);
    for (int i = len; i < widthChars; ++i) M5Lcd.print(' ');
    return;
  }

  // Restart the cycle when the label changes (pointer OR content; the
  // TOOLS/SESSIONS buffers are rewritten in place on BLE pushes).
  if (m.text != text || strcmp(m.text, text) != 0) {
    m.text = text;
    m.offset = 0;
    m.phase = 0;
    m.nextAt = millis() + MQ_HOLD_START_MS;
  }
  m.active = true;
  m.big = false;
  m.maxOff = len - widthChars;
  if (m.offset > m.maxOff) {  // content shrank under us
    m.offset = 0;
    m.phase = 0;
    m.nextAt = millis() + MQ_HOLD_START_MS;
  }
  // register band geometry for direct tick redraws
  m.x = x;
  m.y = y;
  m.widthChars = widthChars;
  m.size = size;
  m.color = color;
  m.bg = bg;
  mqDrawBand(m);
}

// 16 px rich-text marquee: window in pixels, scroll step = 1 codepoint.
static void drawMarquee16(int slot, const char* text, int x, int y,
                          int widthPx, uint16_t color, uint16_t bg) {
  Marquee& m = sMq[slot];
  int fit = cpsFitWidth16(text, widthPx);
  int total = cpCount16(text);
  if (fit >= total) {  // fits: draw statically
    m.active = false;
    m.text = text;
    drawText16(x, y, text, color, bg);
    return;
  }
  if (m.text != text || !m.big || strcmp(m.text, text) != 0) {
    m.text = text;
    m.offset = 0;
    m.phase = 0;
    m.nextAt = millis() + MQ_HOLD_START_MS;
  }
  m.active = true;
  m.big = true;
  m.maxOff = total - fit;
  if (m.offset > m.maxOff) {
    m.offset = 0;
    m.phase = 0;
    m.nextAt = millis() + MQ_HOLD_START_MS;
  }
  m.x = x;
  m.y = y;
  m.widthChars = widthPx;
  m.size = 1;
  m.color = color;
  m.bg = bg;
  mqDrawBand(m);
}

// ---- Logo lookup ----

static const uint16_t* toolLogo(const char* id) {
  if (strstr(id, "claude") != nullptr) return logo_claude;
  if (strstr(id, "codex") != nullptr) return logo_codex;
  if (strstr(id, "opencode") != nullptr) return logo_opencode;
  if (strstr(id, "kimi") != nullptr) return logo_kimi;
  return icon_tool;  // generic fallback
}

// ---- Status bar ----

void uiInit() {
  uiSetOrientation(1);  // 240x135 landscape
  // Our bitmap arrays (icons.h/logos.h) are host-order uint16_t. The driver
  // defaults to _swapBytes=false (In_eSPI.cpp:253), which would send each
  // pixel LSB-first over SPI (pushColors -> spi.writeBytes) and byte-swap
  // every hue; setSwapBytes(true) routes pushImage through spi.writePixels
  // (MSB-first) and makes the transparent-sentinel compare work. Text and
  // primitive drawing do not consult _swapBytes and are unaffected.
  M5Lcd.setSwapBytes(true);
  M5Lcd.fillScreen(TFT_BLACK);
  M5Lcd.setTextColor(TFT_WHITE, TFT_BLACK);
}

static void drawStatusBar(const char* title) {
  M5Lcd.fillRect(0, 0, sW, BAR_H, TFT_BLACK);

  M5Lcd.pushImage(2, 0, 16, 16, logo_bt, ICON_TRANSPARENT);
  if (!bleConnected()) {  // red slash over the rune
    M5Lcd.drawLine(4, 13, 15, 2, TFT_RED);
    M5Lcd.drawLine(5, 14, 16, 3, TFT_RED);
  }

  // Battery icon + percentage, right-aligned.
  const uint16_t* bat = icon_bat_0;
  if (sBatteryPct >= 75) bat = icon_bat_3;
  else if (sBatteryPct >= 40) bat = icon_bat_2;
  else if (sBatteryPct >= 15) bat = icon_bat_1;
  M5Lcd.pushImage(sW - 18, 0, 16, 16, bat, ICON_TRANSPARENT);
  M5Lcd.setTextSize(1);
  M5Lcd.setTextColor(COL_DIM, TFT_BLACK);
  M5Lcd.setCursor(sW - 50, 4);
  if (sBatteryPct >= 0) M5Lcd.printf("%3d%%", sBatteryPct);

  if (title != nullptr && title[0] != '\0') {
    char t[20];
    strlcpy(t, title, sizeof(t));
    int n = charsFit(sW - 110, 1);
    if (n > (int)sizeof(t) - 1) n = sizeof(t) - 1;  // t[20]: never past end
    t[n] = '\0';
    centerText(t, 4, 1, COL_ACCENT);
  }

  M5Lcd.drawFastHLine(0, BAR_H - 1, sW, COL_FAINT);
}

// ---- Waiting (branded boot / host disconnected) ----
// uiShowWaiting draws the static branding once; animation ticks go through
// uiTickWaiting, which erases+redraws ONLY the ring/logo box and the
// message line -- never the whole screen.

static void waitingGeom(int* cx, int* cy) {
  *cx = sW / 2;
  *cy = landscape() ? 88 : (sH * 52) / 100;
}

static int waitingMsgY() {
  return landscape() ? sH - 13 : (sH * 52) / 100 + 42;
}

static void waitingDrawRings(int animPhase) {
  int cx, cy;
  waitingGeom(&cx, &cy);
  M5Lcd.fillRect(cx - 32, cy - 32, 64, 64, TFT_BLACK);  // erase ring box
  static const uint16_t ringCol[3] = {0x0214, 0x04A9, 0x07FF};
  for (int i = 0; i < 3; ++i) {
    int phase = (animPhase + i) % 3;
    M5Lcd.drawCircle(cx, cy, 18 + phase * 6, ringCol[2 - phase]);
  }
  M5Lcd.pushImage(cx - 16, cy - 16, 32, 32, logo_bt_large, ICON_TRANSPARENT);
}

static void waitingDrawMsg(int animPhase) {
  int y = waitingMsgY();
  M5Lcd.fillRect(0, y - 1, sW, 10, TFT_BLACK);  // erase message line
  char dots[4] = "...";
  dots[animPhase + 1] = '\0';
  char msg[24];
  snprintf(msg, sizeof(msg), "Waiting for host%s", dots);
  centerText(msg, y, 1, COL_DIM);
}

void uiShowWaiting(int animPhase) {
  M5Lcd.fillScreen(TFT_BLACK);
  bool land = landscape();

  int nameSize = land ? 3 : 2;
  int nameY = land ? 12 : 28;
  centerText("VibeStick", nameY, nameSize, TFT_WHITE);
  int uw = land ? 120 : sW - 50;
  int uy = nameY + 8 * nameSize + 4;
  M5Lcd.fillRoundRect((sW - uw) / 2, uy, uw, 3, 1, COL_ACCENT);
  centerText("companion for AI CLIs", uy + 7, 1, COL_DIM);

  waitingDrawRings(animPhase);
  waitingDrawMsg(animPhase);
}

void uiTickWaiting(int animPhase) {
  waitingDrawRings(animPhase);
  waitingDrawMsg(animPhase);
}

// ---- Home: tool picker carousel ----
// Entries = host tools + one device-local "Microphone" entry appended
// at the end (index == gTools.count); it exists even with no host tools.

static int homeEntryCount() {
  return (gTools.valid ? gTools.count : 0) + 1;
}

static bool isMicEntry(int idx) {
  return !gTools.valid || idx >= gTools.count;
}

static const uint16_t* entryLogo(int idx) {
  if (isMicEntry(idx)) return icon_mic24;
  return toolLogo(gTools.list[idx].id);
}

void uiShowHome(int selTool) {
  M5Lcd.fillScreen(TFT_BLACK);
  drawStatusBar(nullptr);

  int n = homeEntryCount();
  if (selTool < 0) selTool = 0;
  if (selTool >= n) selTool = n - 1;

  const char* name;
  const char* state;
  if (isMicEntry(selTool)) {
    name = "Microphone";
    state = "voice input";
  } else {
    const ToolEntry& t = gTools.list[selTool];
    name = t.name;  // global buffer: safe for the marquee to keep
    state = t.state;
  }

  int cx = sW / 2;
  int nameY, stateY, dotsY;

  if (landscape()) {
    // Horizontal carousel: prev | selected | next.
    int cy = 52;
    if (n > 1) {
      int prev = (selTool + n - 1) % n;
      int next = (selTool + 1) % n;
      M5Lcd.fillCircle(cx - 74, cy, 20, TFT_BLACK);
      M5Lcd.drawCircle(cx - 74, cy, 20, COL_FAINT);
      M5Lcd.pushImage(cx - 86, cy - 12, 24, 24, entryLogo(prev),
                       ICON_TRANSPARENT);
      M5Lcd.fillCircle(cx + 74, cy, 20, TFT_BLACK);
      M5Lcd.drawCircle(cx + 74, cy, 20, COL_FAINT);
      M5Lcd.pushImage(cx + 62, cy - 12, 24, 24, entryLogo(next),
                       ICON_TRANSPARENT);
    }
    M5Lcd.fillRoundRect(cx - 28, cy - 26, 56, 56, 8, COL_HL);
    M5Lcd.drawRoundRect(cx - 28, cy - 26, 56, 56, 8, COL_ACCENT);
    M5Lcd.pushImage(cx - 12, cy - 10, 24, 24, entryLogo(selTool),
                     ICON_TRANSPARENT);
    nameY = cy + 38;
    stateY = cy + 62;
    dotsY = sH - 5;
  } else {
    // Portrait: vertical carousel (prev above, next below).
    if (n > 1) {
      int prev = (selTool + n - 1) % n;
      int next = (selTool + 1) % n;
      M5Lcd.fillCircle(cx, 40, 18, TFT_BLACK);
      M5Lcd.drawCircle(cx, 40, 18, COL_FAINT);
      M5Lcd.pushImage(cx - 12, 28, 24, 24, entryLogo(prev),
                       ICON_TRANSPARENT);
      M5Lcd.fillCircle(cx, 180, 18, TFT_BLACK);
      M5Lcd.drawCircle(cx, 180, 18, COL_FAINT);
      M5Lcd.pushImage(cx - 12, 168, 24, 24, entryLogo(next),
                       ICON_TRANSPARENT);
    }
    M5Lcd.fillRoundRect(cx - 28, 68, 56, 56, 8, COL_HL);
    M5Lcd.drawRoundRect(cx - 28, 68, 56, 56, 8, COL_ACCENT);
    M5Lcd.pushImage(cx - 12, 84, 24, 24, entryLogo(selTool),
                     ICON_TRANSPARENT);
    nameY = 132;
    stateY = 154;
    dotsY = 212;
  }

  {
    int w16 = textWidth16(name);
    if (w16 <= sW - 8) {
      sMq[MQ_HOME_NAME].active = false;
      sMq[MQ_HOME_NAME].text = nullptr;
      drawText16((sW - w16) / 2, nameY, name, TFT_WHITE, TFT_BLACK);
    } else {
      drawMarquee16(MQ_HOME_NAME, name, 4, nameY, sW - 8, TFT_WHITE,
                    TFT_BLACK);
    }
  }

  // State dot + state text.
  uint16_t stCol = isMicEntry(selTool) ? COL_DIM : stateColor(state);
  int tw = strlen(state) * 6;
  int sx = (sW - tw) / 2;
  M5Lcd.fillCircle(sx - 10, stateY + 4, 4, stCol);
  M5Lcd.setTextSize(1);
  M5Lcd.setTextColor(stCol, TFT_BLACK);
  M5Lcd.setCursor(sx, stateY);
  M5Lcd.print(state);

  // Position dots.
  int dotsW = n * 10 - 4;
  int dx = (sW - dotsW) / 2;
  for (int i = 0; i < n; ++i) {
    M5Lcd.fillCircle(dx + i * 10, dotsY, 2,
                      i == selTool ? COL_ACCENT : COL_FAINT);
  }
}

// ---- Home slide animation ----
// ~150 ms slide transition of the center icon (old slides out, new slides
// in). Runs as per-frame partial redraws of the icon band only; the full
// home redraw (name/state/dots) happens when uiHomeAnimTick() reports
// completion. Button presses during the animation are never dropped: the
// selection moves optimistically and the animation just retargets.

#define HOME_ANIM_MS 150
#define HOME_ANIM_SHIFT 24

static bool sHomeAnim = false;
static int sHomeAnimTo = 0;
static uint32_t sHomeAnimStart = 0;

static void homeCenterGeom(int* fx, int* fy, int* ix, int* iy) {
  int cx = sW / 2;
  if (landscape()) {
    *fx = cx - 28; *fy = 26; *ix = cx - 12; *iy = 42;
  } else {
    *fx = cx - 28; *fy = 68; *ix = cx - 12; *iy = 84;
  }
}

void uiHomeAnimate(int fromIdx, int toIdx) {
  if (fromIdx == toIdx) return;
  int fx, fy, ix, iy;
  homeCenterGeom(&fx, &fy, &ix, &iy);
  sHomeAnimTo = toIdx;
  sHomeAnimStart = millis();
  sHomeAnim = true;
  // first frame: the incoming icon at its start offset
  M5Lcd.fillRect(fx, fy, 56, 56, TFT_BLACK);
  M5Lcd.fillRoundRect(fx, fy, 56, 56, 8, COL_HL);
  M5Lcd.drawRoundRect(fx, fy, 56, 56, 8, COL_ACCENT);
  if (landscape()) {
    M5Lcd.pushImage(ix + HOME_ANIM_SHIFT, iy, 24, 24, entryLogo(toIdx),
                     ICON_TRANSPARENT);
  } else {
    M5Lcd.pushImage(ix, iy + HOME_ANIM_SHIFT, 24, 24, entryLogo(toIdx),
                     ICON_TRANSPARENT);
  }
}

// Draw the next animation frame. Returns true once when the animation
// finishes (caller then does the full home redraw).
bool uiHomeAnimTick() {
  if (!sHomeAnim) return false;
  uint32_t t = millis() - sHomeAnimStart;
  if (t >= HOME_ANIM_MS) {
    sHomeAnim = false;
    return true;
  }
  int shift = HOME_ANIM_SHIFT - (HOME_ANIM_SHIFT * (int)t) / HOME_ANIM_MS;
  int fx, fy, ix, iy;
  homeCenterGeom(&fx, &fy, &ix, &iy);
  M5Lcd.fillRect(fx, fy, 56, 56, TFT_BLACK);
  M5Lcd.fillRoundRect(fx, fy, 56, 56, 8, COL_HL);
  M5Lcd.drawRoundRect(fx, fy, 56, 56, 8, COL_ACCENT);
  if (landscape()) {
    M5Lcd.pushImage(ix + shift, iy, 24, 24, entryLogo(sHomeAnimTo),
                     ICON_TRANSPARENT);
  } else {
    M5Lcd.pushImage(ix, iy + shift, 24, 24, entryLogo(sHomeAnimTo),
                     ICON_TRANSPARENT);
  }
  return false;
}

// ---- Session picker (fake-CLI) ----
// Entry 0 = "+ new session", entries 1..n = SESSIONS list. sel = entry idx.

void uiShowSessionPicker(int sel) {
  M5Lcd.fillScreen(TFT_BLACK);
  drawStatusBar(gStatus.valid ? gStatus.tool : nullptr);

  // Prompt line.
  char prompt[32];
  const char* tid = (gTools.valid && gTools.active < gTools.count)
                        ? gTools.list[gTools.active].id
                        : "tool";
  snprintf(prompt, sizeof(prompt), "%s@vibestick ~ %%", tid);
  {
    int n = charsFit(sW - 8, 1);
    if (n > (int)sizeof(prompt) - 1) n = sizeof(prompt) - 1;
    prompt[n] = '\0';
  }
  M5Lcd.setTextSize(1);
  M5Lcd.setTextColor(COL_GREEN, TFT_BLACK);
  M5Lcd.setCursor(4, 20);
  M5Lcd.print(prompt);

  static const int ROW_H = 18;
  static const int FIRST_Y = 36;
  int n = gSessions.valid ? gSessions.count : 0;
  int entries = 1 + n;  // "+ new session" + sessions
  if (sel < 0) sel = 0;
  if (sel >= entries) sel = entries - 1;
  int visible = (sH - FIRST_Y - 4) / ROW_H;
  int top = sel - visible + 1;
  if (top < 0) top = 0;

  for (int row = 0; row < visible && top + row < entries; ++row) {
    int idx = top + row;
    int y = FIRST_Y + row * ROW_H;
    bool hl = (idx == sel);

    M5Lcd.setTextSize(1);
    if (hl) {
      M5Lcd.setTextColor(COL_AMBER, TFT_BLACK);
      M5Lcd.setCursor(4, y + 5);
      M5Lcd.print(">");
    }

    if (idx == 0) {
      M5Lcd.setTextColor(hl ? COL_AMBER : COL_DIM, TFT_BLACK);
      M5Lcd.setCursor(16, y + 5);
      M5Lcd.print("+ new session");
      continue;
    }

    const SessionEntry& e = gSessions.list[idx - 1];
    // The light is the complete status indicator; keep headlines uncluttered.
    uint16_t light = COL_FAINT;
    if (strcmp(e.state, "running") == 0 || strcmp(e.state, "error") == 0)
      light = TFT_RED;
    else if (strcmp(e.state, "waiting") == 0)
      light = TFT_YELLOW;
    else if (e.fg || strcmp(e.state, "ready") == 0)
      light = TFT_GREEN;
    M5Lcd.fillCircle(18, y + 8, 3, light);

    const char* name = e.name[0] ? e.name : e.id;
    int namePx = sW - 36;
    if (hl) {
      drawMarquee16(MQ_SESSION_ROW, name, 28, y, namePx, TFT_WHITE, TFT_BLACK);
    } else {
      drawText16N(28, y, name, strlen(name), COL_DIM, TFT_BLACK, namePx);
    }
  }

  if (!gSessions.valid) {
    M5Lcd.setTextSize(1);
    M5Lcd.setTextColor(COL_FAINT, TFT_BLACK);
    M5Lcd.setCursor(16, FIRST_Y + ROW_H + 6);
    M5Lcd.print("(no sessions yet)");
  }
}

// ---- Conversation (session viewer) ----
// Layout: header (tool icon + session name + state badge) / content area
// (tail lines, scrollable) / footer status line(s) (icons + short text).
// uiShowConvo draws the full screen on data changes; REC text, RMS bar,
// transcribing dots and tail scrolling are partial redraws only.

static int footDivY() { return landscape() ? sH - 19 : sH - 30; }
static int footL1Y() { return landscape() ? sH - 13 : sH - 24; }
static int footL2Y() { return sH - 13; }  // portrait only
#define CONTENT_Y0 52

static int sCkDots = -1;

// Reading position: index of the displayed tail entry. Values past the end
// clamp to the newest message on draw.
static int sTailIdx = 0;

void uiConvoPageReset() { sTailIdx = TAIL_MAX; }  // -> newest on next draw

// Sync the reading position after a tail content update: keep following
// the live edge only when the user is already at/near the newest page
// (tails usually append one message at a time, so bottom-followers sit at
// count-2 after the push); a user paging through history keeps their page.
void uiConvoTailSync() {
  if (gStatus.tailCount == 0) {
    sTailIdx = 0;
    return;
  }
  if (sTailIdx >= gStatus.tailCount - 2) sTailIdx = gStatus.tailCount - 1;
  if (sTailIdx < 0) sTailIdx = 0;
  if (sTailIdx >= gStatus.tailCount) sTailIdx = gStatus.tailCount - 1;
}

// Header status dot: red = busy (agent reasoning), green = ready for
// input. Breathing pulse via uiTickConvo; full-intensity on full redraws.
static bool sHeaderSendMark = false;  // set by uiShowConvo from the app
static int sDotPhase = -1;

static void convoDrawStatusDot(bool bright) {
  bool busy = sHeaderSendMark ||
              (gStatus.valid && strcmp(gStatus.state, "running") == 0);
  bool ready = gVoice.valid && strcmp(gVoice.state, "ready") == 0 &&
               gVoice.text[0] != '\0';
  M5Lcd.fillRect(2, 18, 20, 20, TFT_BLACK);  // erase dot region
  uint16_t col;
  if (busy) {           // red: agent reasoning / send in flight
    col = bright ? TFT_RED : 0x4800;
  } else if (ready) {   // blue: transcript waiting for confirmation
    col = bright ? TFT_BLUE : 0x0010;
  } else {              // green: ready for input
    col = bright ? TFT_GREEN : 0x02A0;
  }
  M5Lcd.fillCircle(12, 27, 4, col);
}

void uiTickConvo() {
  // Status dot breathing (partial redraw of the dot area only).
  {
    int phase = (millis() / 500) % 2;
    if (phase != sDotPhase) {
      sDotPhase = phase;
      convoDrawStatusDot(phase == 0);
    }
  }

  // Transcribing: animated dots on footer line 1, redrawn only on phase
  // changes (partial redraw, no flicker).
  const char* vst = gVoice.valid ? gVoice.state : "idle";
  if (strcmp(vst, "transcribing") == 0) {
    int dots = (millis() / 400) % 4;
    if (dots != sCkDots) {
      sCkDots = dots;
      M5Lcd.fillRect(0, footL1Y() - 1, 100, 10, TFT_BLACK);
      M5Lcd.setTextSize(1);
      M5Lcd.setTextColor(COL_AMBER, TFT_BLACK);
      M5Lcd.setCursor(4, footL1Y());
      M5Lcd.print("transcribing");
      for (int i = 0; i < dots; ++i) M5Lcd.print(".");
    }
  } else {
    sCkDots = -1;
  }
}

// ---- Full-screen recording view (shared by conversation and mic) ----
// Red dot + REC timer on top, one big RMS bar with a green->yellow->red
// volume gradient. Timer/bar are partial redraws via uiTickRecording.

static bool sRcInit = false;
static bool sRcBlink = false;
static int sRcSec = -1, sRcLevel = -1;

// Green (0,255,0) -> yellow (255,255,0) -> red (255,0,0), RGB565.
static uint16_t levelColor(int pct) {
  int r, g;
  if (pct < 50) {
    r = (pct * 255) / 50;
    g = 255;
  } else {
    r = 255;
    g = 255 - ((pct - 50) * 255) / 50;
  }
  return (uint16_t)(((r & 0xF8) << 8) | ((g & 0xFC) << 3));
}

static void recBarGeom(int* x, int* y, int* w, int* h, bool* vertical) {
  *vertical = !landscape();
  if (*vertical) {
    *x = sW / 2 - 8;
    *y = 48;
    *w = 16;
    *h = footDivY() - 12 - 48;
  } else {
    *x = 24;
    *y = sH / 2 + 6;
    *w = sW - 48;
    *h = 14;
  }
}

static void recDrawBar(int levelPct) {
  int x, y, w, h;
  bool vertical;
  recBarGeom(&x, &y, &w, &h, &vertical);
  uint16_t col = levelColor(levelPct);
  if (vertical) {
    M5Lcd.fillRect(x, y, w, h, TFT_BLACK);
    int fh = (h * levelPct) / 100;
    if (fh > 0) M5Lcd.fillRect(x, y + h - fh, w, fh, col);
  } else {
    M5Lcd.fillRect(x, y, w, h, TFT_BLACK);
    int fw = (w * levelPct) / 100;
    if (fw > 0) M5Lcd.fillRect(x, y, fw, h, col);
  }
}

void uiTickRecording(int levelPct, uint32_t elapsedMs) {
  bool blink = (millis() / 500) % 2 == 0;
  int sec = elapsedMs / 1000;
  if (!sRcInit || blink != sRcBlink || sec != sRcSec) {
    M5Lcd.fillRect(0, 24, sW, 16, TFT_BLACK);  // erase timer band
    char buf[16];
    snprintf(buf, sizeof(buf), "REC %02d:%02d", sec / 60, sec % 60);
    int tw = strlen(buf) * 6;
    int x0 = (sW - tw) / 2;
    if (blink) M5Lcd.fillCircle(x0 - 12, 31, 5, TFT_RED);
    M5Lcd.setTextSize(1);
    M5Lcd.setTextColor(TFT_RED, TFT_BLACK);
    M5Lcd.setCursor(x0, 27);
    M5Lcd.print(buf);
    sRcBlink = blink;
    sRcSec = sec;
    sRcInit = true;
  }
  if (levelPct != sRcLevel) {
    recDrawBar(levelPct);
    sRcLevel = levelPct;
  }
}

void uiShowRecording(int levelPct, uint32_t elapsedMs) {
  M5Lcd.fillScreen(TFT_BLACK);
  drawStatusBar("rec");
  int x, y, w, h;
  bool vertical;
  recBarGeom(&x, &y, &w, &h, &vertical);
  M5Lcd.drawRect(x - 2, y - 2, w + 4, h + 4, COL_DIM);  // bar outline
  M5Lcd.drawFastHLine(0, footDivY(), sW, COL_FAINT);
  centerText("release: stop", footL1Y(), 1, COL_FAINT);
  sRcInit = false;
  sRcLevel = -1;
  uiTickRecording(levelPct, elapsedMs);
}

// ---- tail reading view: one message at a time ----
// A = older, B = newer, double-click A = back to the newest. Each message
// fills the content area (wrapped, tail-truncated with "..."); position
// indicator k/N sits at the bottom-right of the content area.

static void clampTailIdx() {
  if (gStatus.tailCount == 0) {
    sTailIdx = 0;
    return;
  }
  if (sTailIdx >= gStatus.tailCount) sTailIdx = gStatus.tailCount - 1;
  if (sTailIdx < 0) sTailIdx = 0;
}

static void drawConvoMessage() {
  clampTailIdx();

  int indY = footDivY() - 10;  // position indicator line
  int maxLines = (indY - 2 - CONTENT_Y0) / 18;
  if (maxLines < 1) maxLines = 1;

  const char* p = gStatus.tail[sTailIdx];
  uint16_t col = strncmp(p, "user:", 5) == 0 ? COL_AMBER : COL_GREEN;
  drawWrapped16(4, CONTENT_Y0, p, sW - 8, maxLines, col);

  char pos[12];
  snprintf(pos, sizeof(pos), "%d/%d", sTailIdx + 1, gStatus.tailCount);
  M5Lcd.setTextColor(COL_FAINT, TFT_BLACK);
  M5Lcd.setCursor(sW - 8 - strlen(pos) * 6, indY);
  M5Lcd.print(pos);
}

// Page through tail entries; delta < 0 = older, > 0 = newer. Partial
// redraw of the content area only; no-op at the ends.
void uiConvoPage(int delta) {
  if (gStatus.tailCount == 0) return;
  clampTailIdx();
  int ns = sTailIdx + delta;
  if (ns < 0) ns = 0;
  if (ns > gStatus.tailCount - 1) ns = gStatus.tailCount - 1;
  if (ns == sTailIdx) return;
  sTailIdx = ns;
  Serial.printf("[UI] convo page -> %d/%d\n", sTailIdx + 1,
                gStatus.tailCount);
  M5Lcd.fillRect(0, CONTENT_Y0, sW, footDivY() - 2 - CONTENT_Y0, TFT_BLACK);
  drawConvoMessage();
}

// Partial redraw of the content area (tail-only STATUS update). Shows the
// newest message (the app resets the page on tail changes).
void uiRedrawConvoTail() {
  M5Lcd.fillRect(0, CONTENT_Y0, sW, footDivY() - 2 - CONTENT_Y0, TFT_BLACK);
  if (gStatus.tailCount > 0) drawConvoMessage();
}

// Ready transcript in the content area (wrapped, green).
static void drawConvoTranscript() {
  int maxLines = (footDivY() - 12 - CONTENT_Y0) / 18;
  if (maxLines < 1) maxLines = 1;
  drawWrapped16(4, CONTENT_Y0, gVoice.text, sW - 8, maxLines, COL_GREEN);
}

// Compact, language-independent footer legend. Button letters stay familiar,
// while the adjacent geometry explains their current action at a glance.
static void hintButton(int x, int y, char key, uint16_t color = COL_FAINT) {
  M5Lcd.drawCircle(x, y, 7, color);
  M5Lcd.setTextSize(1);
  M5Lcd.setTextColor(color, TFT_BLACK);
  M5Lcd.setCursor(x - 3, y - 3);
  M5Lcd.print(key);
}

static void hintArrow(int x, int y, bool right, uint16_t color = COL_FAINT) {
  if (right) M5Lcd.fillTriangle(x + 5, y, x - 3, y - 5, x - 3, y + 5, color);
  else M5Lcd.fillTriangle(x - 5, y, x + 3, y - 5, x + 3, y + 5, color);
}

static void hintSend(int x, int y, uint16_t color = COL_AMBER) {
  M5Lcd.fillTriangle(x + 7, y, x - 5, y - 6, x - 5, y + 6, color);
}

static void hintStop(int x, int y, uint16_t color = TFT_RED) {
  M5Lcd.fillRect(x - 5, y - 5, 10, 10, color);
}

static void hintMic(int x, int y, uint16_t color = COL_FAINT) {
  M5Lcd.drawRoundRect(x - 3, y - 7, 6, 10, 3, color);
  M5Lcd.drawFastVLine(x, y + 3, 4, color);
  M5Lcd.drawFastHLine(x - 4, y + 7, 9, color);
}

static void hintDoubleA(int x, int y) {
  hintButton(x - 4, y, 'A');
  hintButton(x + 5, y, 'A');
}

static void drawFooterHints(const char* mode, int y) {
  // mode: page | record | send | busy | queued
  if (strcmp(mode, "page") == 0) {
    hintButton(12, y, 'A'); hintArrow(25, y, false);
    hintButton(48, y, 'B'); hintArrow(61, y, true);
    hintDoubleA(sW - 40, y); hintMic(sW - 12, y);
  } else if (strcmp(mode, "record") == 0) {
    int x = landscape() ? sW - 36 : 14;
    hintMic(x, y, TFT_RED); hintButton(x + 20, y, 'A');
  } else if (strcmp(mode, "send") == 0) {
    if (landscape()) {
      hintButton(sW - 45, y, 'A', COL_AMBER); hintSend(sW - 30, y);
      hintMic(sW - 12, y);
    } else {
      hintButton(12, y, 'A', COL_AMBER); hintSend(27, y);
      hintDoubleA(sW - 40, y); hintMic(sW - 12, y);
    }
  } else if (strcmp(mode, "busy") == 0) {
    int x = landscape() ? sW - 45 : 12;
    hintButton(x, y, 'A', TFT_RED); hintStop(x + 15, y);
    hintMic(sW - 12, y, COL_AMBER);
  } else {  // queued
    int x = landscape() ? sW - 44 : 12;
    hintMic(x, y, COL_AMBER);
    M5Lcd.drawRect(x + 11, y - 5, 9, 9, COL_AMBER);
    M5Lcd.drawRect(x + 15, y - 9, 9, 9, COL_AMBER);
  }
}

// Footer status line(s): icons + short text + context hints.
static void drawConvoFooter(const char* errorText, bool sendMarked,
                            bool sentBusy, const char* st) {
  M5Lcd.drawFastHLine(0, footDivY(), sW, COL_FAINT);
  const char* vst = gVoice.valid ? gVoice.state : "idle";
  bool ready = strcmp(vst, "ready") == 0;
  bool land = landscape();
  int y1 = footL1Y();

  M5Lcd.setTextSize(1);
  if (errorText != nullptr) {
    M5Lcd.setTextColor(TFT_RED, TFT_BLACK);
    M5Lcd.setCursor(4, y1);
    M5Lcd.print("! ");
    drawMarquee(MQ_TRANSCRIPT, errorText, 16, y1, charsFit(sW - 24, 1), 1,
                TFT_RED, TFT_BLACK);
    drawFooterHints("record", land ? y1 : footL2Y());
  } else if (strcmp(vst, "transcribing") == 0) {
    M5Lcd.setTextColor(COL_AMBER, TFT_BLACK);
    M5Lcd.setCursor(4, y1);
    M5Lcd.print("transcribing");  // dots animated by uiTickConvo
  } else if (ready && gVoice.text[0]) {
    drawFooterHints("send", y1);
  } else if (sendMarked) {
    // Just sent: idle session -> immediate thinking indicator; busy
    // session -> queued until the next STATUS update resolves it.
    M5Lcd.setTextColor(COL_AMBER, TFT_BLACK);
    if (sentBusy) {
      drawFooterHints("queued", y1);
    } else {
      M5Lcd.fillTriangle(5, y1 + 7, 11, y1 + 7, 8, y1 + 1, COL_AMBER);
      M5Lcd.setCursor(16, y1);
      M5Lcd.print("thinking...");
    }
  } else if (strcmp(st, "running") == 0) {
    M5Lcd.fillTriangle(5, y1 + 7, 11, y1 + 7, 8, y1 + 1, COL_AMBER);
    M5Lcd.setTextColor(COL_AMBER, TFT_BLACK);
    M5Lcd.setCursor(16, y1);
    M5Lcd.print("thinking...");
    drawFooterHints("busy", land ? y1 : footL2Y());
  } else {
    drawFooterHints("page", y1);
  }
}

void uiShowConvo(bool sendMarked, bool sentBusy, const char* errorText) {
  M5Lcd.fillScreen(TFT_BLACK);
  drawStatusBar("session");

  const char* tool = gStatus.valid ? gStatus.tool : "";
  const char* sess = gStatus.valid && gStatus.session[0] ? gStatus.session
                                                         : "(no session)";
  const char* st = gStatus.valid ? gStatus.state : "idle";

  // Header: status dot + session name + state badge.
  // Dot: red = busy (state running, or a send is in flight), green = ready.
  sHeaderSendMark = sendMarked;
  convoDrawStatusDot(true);
  int badgeW = strlen(st) * 6 + 8;
  drawMarquee16(MQ_CONVO_HDR, sess, 24, 20, sW - 24 - 10 - badgeW, COL_GREEN,
                TFT_BLACK);
  M5Lcd.drawRoundRect(sW - 6 - badgeW, 20, badgeW, 14, 3, stateColor(st));
  M5Lcd.setTextSize(1);
  M5Lcd.setTextColor(stateColor(st), TFT_BLACK);
  M5Lcd.setCursor(sW - 6 - badgeW + 4, 23);
  M5Lcd.print(st);
  M5Lcd.drawFastHLine(0, 38, sW, COL_FAINT);

  if (!gStatus.valid) {
    centerText("waiting for status...", sH / 2, 1, COL_FAINT);
  } else {
    // Compact ctx/cost line.
    if (gStatus.ctxPct >= 0) {
      int pct = gStatus.ctxPct > 100 ? 100 : gStatus.ctxPct;
      M5Lcd.setTextColor(COL_FAINT, TFT_BLACK);
      M5Lcd.setCursor(4, 44);
      M5Lcd.print("ctx");
      M5Lcd.drawRect(24, 43, 64, 9, COL_DIM);
      M5Lcd.fillRect(25, 44, (62 * pct) / 100, 7,
                      pct >= 90 ? TFT_RED : TFT_GREEN);
      M5Lcd.setTextColor(TFT_WHITE, TFT_BLACK);
      M5Lcd.setCursor(92, 44);
      M5Lcd.printf("%d%%", pct);
    }
    if (gStatus.costUsd >= 0.0f) {
      char cost[16];
      snprintf(cost, sizeof(cost), "$%.2f", gStatus.costUsd);
      M5Lcd.setTextColor(COL_AMBER, TFT_BLACK);
      M5Lcd.setCursor(sW - 8 - strlen(cost) * 6, 44);
      M5Lcd.print(cost);
    }

    // Body: transcript view when ready, else the tail reading view, else
    // the classic last summary (wrapped or marquee).
    bool ready = gVoice.valid && strcmp(gVoice.state, "ready") == 0 &&
                 gVoice.text[0] != '\0';
    if (ready) {
      drawConvoTranscript();
    } else if (gStatus.tailCount > 0) {
      drawConvoMessage();
    } else {
      int maxLines = (footDivY() - 4 - CONTENT_Y0) / 18;
      if (maxLines < 1) maxLines = 1;
      drawWrapped16(4, CONTENT_Y0, gStatus.last, sW - 8, maxLines, COL_DIM);
    }
  }

  drawConvoFooter(errorText, sendMarked, sentBusy, st);
  sCkDots = -1;
}

// ---- Microphone (device-local voice-input mode) ----
// Pure hold-to-talk: voice.start {"mode":"mic"} -> AUDIO -> voice.stop.
// Idle view below; while held, the shared full-screen recording view
// (uiShowRecording) takes over. No transcript/confirm states.

void uiShowMic(const char* errorText) {
  // Minimal microphone screen: big mic glyph in a ring, one status line,
  // one hint line. Recording switches to the full-screen RMS view.
  M5Lcd.fillScreen(TFT_BLACK);
  drawStatusBar(nullptr);

  int cx = sW / 2;
  bool land = landscape();
  int ringR = land ? 26 : 30;
  int cy = land ? 52 : (sH * 36) / 100;

  M5Lcd.drawCircle(cx, cy, ringR, COL_FAINT);
  // Mic glyph at 2x (per-pixel) inside the ring.
  for (int gy = 0; gy < 24; ++gy) {
    for (int gx = 0; gx < 24; ++gx) {
      uint16_t px = pgm_read_word(icon_mic24 + gy * 24 + gx);
      if (px != ICON_TRANSPARENT) {
        M5Lcd.fillRect(cx - 24 + gx * 2, cy - 24 + gy * 2, 2, 2, TFT_WHITE);
      }
    }
  }

  // "VibeStick Mic" (16 px rich text) + connection state below it.
  const char* title = "VibeStick Mic";
  drawText16((sW - textWidth16(title)) / 2, cy + ringR + 10, title, TFT_WHITE,
             TFT_BLACK);
  const char* st = bleConnected() ? "connected" : "advertising";
  uint16_t stCol = bleConnected() ? TFT_GREEN : COL_AMBER;
  centerText(st, cy + ringR + 30, 1, stCol);

  // Bottom hint line(s).
  M5Lcd.drawFastHLine(0, footDivY(), sW, COL_FAINT);
  M5Lcd.setTextSize(1);
  M5Lcd.setTextColor(COL_FAINT, TFT_BLACK);
  if (land) {
    centerText("hold A: talk  B: F20  pwr: back", footL1Y(), 1, COL_FAINT);
  } else {
    centerText("hold A: talk  B: F20", footL1Y(), 1, COL_FAINT);
    centerText("pwr: back", footL2Y(), 1, COL_FAINT);
  }

  // Recent voice error, if any (replaces the hint line).
  if (errorText != nullptr) {
    M5Lcd.setTextColor(TFT_RED, TFT_BLACK);
    M5Lcd.setCursor(4, footL1Y());
    M5Lcd.print("! ");
    drawMarquee(MQ_TRANSCRIPT, errorText, 16, footL1Y(),
                charsFit(sW - 24, 1), 1, TFT_RED, TFT_BLACK);
  }
  sCkDots = -1;
}
