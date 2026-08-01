#pragma once

#include <Arduino.h>

// Board abstraction: VibeStick runs on M5StickC Plus (ESP32-PICO, AXP192,
// MPU6886, SPM1423 PDM mic) and M5StickS3 (ESP32-S3-PICO, M5PM1, BMI270,
// ES8311 codec mic). Everything board-specific goes through these wrappers;
// app/UI code stays board-agnostic.
//
// M5Lcd aliases the display object (M5.Lcd on StickC Plus' TFT_eSPI fork,
// M5.Display on M5Unified/LovyanGFX -- the calls we use exist in both).

#ifdef VIBESTICK_BOARD_S3
#include <M5Unified.h>
#define M5Lcd M5.Display
#define BOARD_NAME "VibeStick v0.2.18 (M5StickS3)"
#define BOARD_MODEL "M5StickS3"
#else
#include <M5StickCPlus.h>
#define M5Lcd M5.Lcd
#define BOARD_NAME "VibeStick v0.2.18 (M5StickC Plus)"
#define BOARD_MODEL "M5StickC-Plus"
#endif

#define FIRMWARE_VERSION "0.2.18"

// One-time board init (M5.begin + display brightness).
void boardInit();
// Stable BLE identity derived from the board's factory MAC, e.g. VibeStick_A1B2.
const char* boardDeviceName();
// Per-loop update (button scanning etc.).
void boardUpdate();

// Buttons A (front/KEY1) and B (side/KEY2), same semantics on both boards.
bool boardBtnA_wasPressed();
bool boardBtnA_wasReleased();
bool boardBtnA_isPressed();
bool boardBtnB_wasPressed();
bool boardBtnB_wasReleased();
bool boardBtnB_isPressed();

// Power key edge events: 0 = none, 1 = long press, 2 = short press.
// StickC Plus: AXP192 PEK IRQ. StickS3: M5PM1 click IRQ after boardInit()
// disables the PMU's single-reset and double-off actions. A two-second hold
// remains owned by the PMU and enters download mode.
uint8_t boardPowerButtonEvent();

// Restart the MCU from the application (used for a short press on the home
// screen). The S3 PMU is configured so this is the only short-press reset.
void boardRestart();

// Battery level 0..100, -1 when unknown.
int boardBatteryPct();

// Display backlight 0..100.
void boardBrightness(int pct);

// IMU: returns false when no IMU data is available.
bool boardGetAccel(float* x, float* y, float* z);
