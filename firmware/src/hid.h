#pragma once

#include <NimBLEServer.h>

// BLE HID keyboard over the same device/link as the VibeStick GATT service.
// Button A -> F13, Button B -> F14 (press/release follow the physical
// buttons, so they double as global PTT/shortcut bindings for desktop
// apps). The power key intentionally sends nothing (back/home semantics).

#define VIBESTICK_HID_KEY_A 0x68  // F13
#define VIBESTICK_HID_KEY_B 0x69  // F14

// Attach the HID service to the existing server (call after the VibeStick
// GATT service is created, before advertising starts).
void hidInit(NimBLEServer* pServer);

// Send one key press (pressed=true) or release. No-ops when not connected.
void hidKey(uint8_t keycode, bool pressed);
