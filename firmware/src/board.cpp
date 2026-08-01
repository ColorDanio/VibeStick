#include "board.h"

#ifdef VIBESTICK_BOARD_S3

// ---- M5StickS3 (ESP32-S3-PICO, M5Unified) ----

static char sDeviceName[16] = "VibeStick";

static void initDeviceName() {
  uint64_t mac = ESP.getEfuseMac();
  snprintf(sDeviceName, sizeof(sDeviceName), "VibeStick_%04llX",
           (unsigned long long)(mac & 0xFFFF));
}

// StickS3's side key is managed by the M5PM1 power controller. Its factory
// configuration treats a single click as a hardware reset, so the ESP32 never
// gets a chance to route that click to the UI. Keep the two-second download
// gesture, but make short/double clicks application events instead.
static void configurePowerButton() {
  constexpr uint8_t kButtonConfig1 = 0x49;
  constexpr uint8_t kButtonConfig2 = 0x4A;
  constexpr uint8_t kSingleResetDisable = 1u << 0;
  constexpr uint8_t kLongPressMask = 0x03u << 3;
  constexpr uint8_t kLongPressTwoSeconds = 0x01u << 3;
  constexpr uint8_t kDoubleOffDisable = 1u << 0;

  uint8_t cfg1 = M5.Power.M5pm1.readRegister8(kButtonConfig1);
  cfg1 |= kSingleResetDisable;
  cfg1 = (cfg1 & ~kLongPressMask) | kLongPressTwoSeconds;
  const bool cfg1Ok = M5.Power.M5pm1.writeRegister8(kButtonConfig1, cfg1);

  uint8_t cfg2 = M5.Power.M5pm1.readRegister8(kButtonConfig2);
  cfg2 |= kDoubleOffDisable;
  const bool cfg2Ok = M5.Power.M5pm1.writeRegister8(kButtonConfig2, cfg2);
  const bool irqOk = M5.Power.M5pm1.setButtonIRQMaskBits(0x00);

  // Discard a click that may have been latched while the PMU was starting.
  M5.Power.M5pm1.clearButtonIRQStatus();
  Serial.printf("[PWR] PM1 app button mode: reset=%s double-off=%s irq=%s long=2s\n",
                cfg1Ok ? "disabled" : "unchanged",
                cfg2Ok ? "disabled" : "unchanged",
                irqOk ? "enabled" : "unchanged");
}

const char* boardDeviceName() { return sDeviceName; }

void boardInit() {
  initDeviceName();
  auto cfg = M5.config();
  M5.begin(cfg);
  // Keep M5Unified's board-specific panel colour order.  Overriding it here
  // swaps red and blue on the StickS3 (the Bluetooth blue then looks orange).
  // S3 physical orientation contract: USB-C down is rotation 0.
  M5.Display.setRotation(0);
  M5.Display.setBrightness(200);
  configurePowerButton();
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
  // M5PM1 reports both single and double clicks as a power-key event. The
  // single-reset/double-off actions are disabled in boardInit(), leaving the
  // application in control. A two-second hold still enters download mode in
  // the PMU and therefore does not return here.
  return M5.Power.getKeyState();
}

void boardRestart() { ESP.restart(); }

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

void boardRestart() { ESP.restart(); }

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
