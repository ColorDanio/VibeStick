#include "board.h"

#ifdef VIBESTICK_BOARD_S3

// ---- M5StickS3 (ESP32-S3-PICO, M5Unified) ----

#define PIN_BTN_A 11  // KEY1
#define PIN_BTN_B 12  // KEY2

void boardInit() {
  auto cfg = M5.config();
  M5.begin(cfg);
  // StickS3's ST7789P3 panel uses RGB order. M5GFX's generic ST7789 setup
  // defaults to BGR, which swaps the blue and red components of UI assets.
  auto panelCfg = M5.Display.panel()->config();
  panelCfg.rgb_order = true;
  M5.Display.panel()->config(panelCfg);
  M5.Display.setRotation(1);
  M5.Display.setBrightness(200);
  pinMode(PIN_BTN_A, INPUT_PULLUP);
  pinMode(PIN_BTN_B, INPUT_PULLUP);
}

void boardUpdate() {}

// Simple GPIO button edge tracking (active-low, ~10 ms debounce via
// caller's M5.update-free polling at loop rate).
static bool sA = false, sAprev = false, sApress = false, sArelease = false;
static bool sB = false, sBprev = false, sBpress = false, sBrelease = false;

static void pollBtn(int pin, bool& cur, bool& prev, bool& press, bool& rel) {
  prev = cur;
  cur = digitalRead(pin) == LOW;
  press = cur && !prev;
  rel = !cur && prev;
}

static void pollButtonsRaw() {
  pollBtn(PIN_BTN_A, sA, sAprev, sApress, sArelease);
  pollBtn(PIN_BTN_B, sB, sBprev, sBpress, sBrelease);
}

bool boardBtnA_wasPressed() {
  pollButtonsRaw();
  bool v = sApress;
  sApress = false;
  return v;
}
bool boardBtnA_wasReleased() {
  bool v = sArelease;
  sArelease = false;
  return v;
}
bool boardBtnA_isPressed() { return digitalRead(PIN_BTN_A) == LOW; }
bool boardBtnB_wasPressed() {
  pollButtonsRaw();
  bool v = sBpress;
  sBpress = false;
  return v;
}
bool boardBtnB_wasReleased() {
  bool v = sBrelease;
  sBrelease = false;
  return v;
}
bool boardBtnB_isPressed() { return digitalRead(PIN_BTN_B) == LOW; }

uint8_t boardPowerButtonEvent() { return 0; }  // no AXP192-style power key

int boardBatteryPct() {
  int lvl = M5.Power.getBatteryLevel();  // 0..100, -1 if unsupported
  return lvl;
}

void boardBrightness(int pct) {
  if (pct < 0) pct = 0;
  if (pct > 100) pct = 100;
  M5.Display.setBrightness((uint8_t)(pct * 255 / 100));
}

bool boardGetAccel(float* x, float* y, float* z) {
  M5.Imu.getAccel(x, y, z);
  return true;
}

#else

// ---- M5StickC Plus (ESP32-PICO, M5StickCPlus lib) ----

void boardInit() {
  M5.begin();
  M5.Axp.ScreenBreath(80);
  M5.IMU.Init();
}

void boardUpdate() { M5.update(); }

bool boardBtnA_wasPressed() { return M5.BtnA.wasPressed(); }
bool boardBtnA_wasReleased() { return M5.BtnA.wasReleased(); }
bool boardBtnA_isPressed() { return M5.BtnA.isPressed(); }
bool boardBtnB_wasPressed() { return M5.BtnB.wasPressed(); }
bool boardBtnB_wasReleased() { return M5.BtnB.wasReleased(); }
bool boardBtnB_isPressed() { return M5.BtnB.isPressed(); }

uint8_t boardPowerButtonEvent() { return M5.Axp.GetBtnPress(); }

int boardBatteryPct() {
  float v = M5.Axp.GetBatVoltage();
  int pct = (int)((v - 3.3f) / (4.2f - 3.3f) * 100.0f);
  if (pct < 0) pct = 0;
  if (pct > 100) pct = 100;
  return pct;
}

void boardBrightness(int pct) { M5.Axp.ScreenBreath(pct); }

bool boardGetAccel(float* x, float* y, float* z) {
  M5.IMU.getAccelData(x, y, z);
  return true;
}

#endif
