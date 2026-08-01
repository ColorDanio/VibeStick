#include "board.h"

#ifdef VIBESTICK_BOARD_S3

// ---- M5StickS3 (ESP32-S3-PICO, M5Unified) ----

static char sDeviceName[16] = "VibeStick";

static void initDeviceName() {
  uint64_t mac = ESP.getEfuseMac();
  snprintf(sDeviceName, sizeof(sDeviceName), "VibeStick_%04llX",
           (unsigned long long)(mac & 0xFFFF));
}

const char* boardDeviceName() { return sDeviceName; }

void boardInit() {
  initDeviceName();
  auto cfg = M5.config();
  M5.begin(cfg);
  // Keep M5Unified's board-specific panel colour order.  Overriding it here
  // swaps red and blue on the StickS3 (the Bluetooth blue then looks orange).
  // On StickS3's panel rotation 2, not 0, is portrait with USB-C at the
  // physical bottom. Rotation 0 puts the UI's top-left at the bottom-left.
  M5.Display.setRotation(2);
  M5.Display.setBrightness(200);
}

// StickS3's A/B GPIOs are board-specific. M5Unified owns their debounce;
// callers must use these event objects after boardUpdate() rather than reading
// the GPIOs directly.
void boardUpdate() { M5.update(); }

bool boardBtnA_wasPressed() { return M5.BtnA.wasPressed(); }
bool boardBtnA_wasReleased() { return M5.BtnA.wasReleased(); }
bool boardBtnA_isPressed() { return M5.BtnA.isPressed(); }
bool boardBtnB_wasPressed() { return M5.BtnB.wasPressed(); }
bool boardBtnB_wasReleased() { return M5.BtnB.wasReleased(); }
bool boardBtnB_isPressed() { return M5.BtnB.isPressed(); }

uint8_t boardPowerButtonEvent() {
  // StickS3's side key is a hardware power/reset control: single-click reset,
  // double-click power off, long-press download mode. It can reset or power
  // down the MCU before app code receives an event, so it is not an app key.
  return 0;
}

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

static char sDeviceName[16] = "VibeStick";

static void initDeviceName() {
  uint64_t mac = ESP.getEfuseMac();
  snprintf(sDeviceName, sizeof(sDeviceName), "VibeStick_%04llX",
           (unsigned long long)(mac & 0xFFFF));
}

const char* boardDeviceName() { return sDeviceName; }

void boardInit() {
  initDeviceName();
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
