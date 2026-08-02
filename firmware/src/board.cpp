#include "board.h"

#ifdef VIBESTICK_BOARD_S3

// ---- M5StickS3 (ESP32-S3-PICO, M5Unified) ----

#include <M5PM1.h>

static char sDeviceName[16] = "VibeStick";
static M5PM1 sPm1;
static bool sPm1Ready = false;
static bool sPm1Pressed = false;
static uint32_t sPm1PressedAt = 0;

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
  // Use the dedicated M5PM1 driver rather than M5Unified's compatibility
  // wrapper.  The wrapper only consumes IRQ_STATUS3; the PM1 button state is
  // exposed in BTN_STATUS and is the reliable source on StickS3 hardware.
  const m5pm1_err_t init =
      sPm1.begin(&M5.In_I2C, M5PM1_DEFAULT_ADDR, M5PM1_I2C_FREQ_DEFAULT);
  if (init == M5PM1_OK) {
    sPm1Ready = true;
    const m5pm1_err_t reset = sPm1.setSingleResetDisable(true);
    const m5pm1_err_t doubleOff = sPm1.setDoubleOffDisable(true);
    const m5pm1_err_t longPress =
        sPm1.btnSetConfig(M5PM1_BTN_TYPE_LONG,
                          M5PM1_BTN_LONG_PRESS_DELAY_2000MS);
    const m5pm1_err_t irq = sPm1.irqSetBtnMaskAll(M5PM1_IRQ_MASK_DISABLE);
    const m5pm1_err_t clear = sPm1.irqClearBtnAll();

    // Establish the initial level so a key held while the board boots does
    // not become a synthetic click when the first loop runs.
    bool pressed = false;
    if (sPm1.btnGetState(&pressed) == M5PM1_OK) sPm1Pressed = pressed;
    Serial.printf(
        "[PWR] PM1 app button driver: ready reset=%s double-off=%s "
        "long=%s irq=%s clear=%s\n",
        reset == M5PM1_OK ? "disabled" : "failed",
        doubleOff == M5PM1_OK ? "disabled" : "failed",
        longPress == M5PM1_OK ? "2s" : "failed",
        irq == M5PM1_OK ? "enabled" : "failed",
        clear == M5PM1_OK ? "ok" : "failed");
    return;
  }

  // Keep the old register path as a degraded fallback if the optional
  // dedicated driver cannot initialize. This still leaves the firmware
  // bootable on an unexpected PM1 revision.
  const uint8_t kButtonConfig1 = 0x49;
  const uint8_t kButtonConfig2 = 0x4A;
  uint8_t cfg1 = M5.Power.M5pm1.readRegister8(kButtonConfig1);
  cfg1 |= 1u << 0;  // single-reset disable
  cfg1 = (cfg1 & ~(0x03u << 3)) | (0x01u << 3);  // long press = 2 s
  const bool cfg1Ok = M5.Power.M5pm1.writeRegister8(kButtonConfig1, cfg1);
  uint8_t cfg2 = M5.Power.M5pm1.readRegister8(kButtonConfig2);
  cfg2 |= 1u << 0;  // double-off disable
  const bool cfg2Ok = M5.Power.M5pm1.writeRegister8(kButtonConfig2, cfg2);
  const bool irqOk = M5.Power.M5pm1.setButtonIRQMaskBits(0x00);
  M5.Power.M5pm1.clearButtonIRQStatus();
  Serial.printf("[PWR] PM1 dedicated driver failed (%d); fallback reset=%s "
                "double-off=%s irq=%s long=2s\n",
                (int)init, cfg1Ok ? "disabled" : "unchanged",
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
  // Read the PM1 level directly and synthesize a click on release. This avoids
  // the M5Unified compatibility wrapper consuming the PMU IRQ before the app
  // can see it. A long hold never becomes a click because PM1 enters download
  // mode at the configured two-second threshold before release.
  if (sPm1Ready) {
    bool pressed = false;
    if (sPm1.btnGetState(&pressed) == M5PM1_OK) {
      const uint32_t now = millis();
      if (pressed && !sPm1Pressed) {
        sPm1PressedAt = now;
      } else if (!pressed && sPm1Pressed) {
        const uint32_t held = now - sPm1PressedAt;
        sPm1Pressed = false;
        if (held < 2000) return 2;
      }
      sPm1Pressed = pressed;
    }
  }

  // Compatibility fallback for PM1 revisions where BTN_STATUS is not
  // readable. M5.update() has already latched these one-shot events.
  if (M5.BtnPWR.wasClicked()) return 2;
  if (M5.BtnPWR.wasHold()) return 1;
  return 0;
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
