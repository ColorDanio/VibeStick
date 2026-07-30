#pragma once

#include <NimBLEServer.h>

// BLE HID keyboard over the same device/link as the VibeStick GATT service.
// Button A -> F14, Button B -> F15 by default (press/release follow the physical
// buttons, so they double as global PTT/shortcut bindings for desktop
// apps). The power key intentionally sends nothing (back/home semantics).

#define VIBESTICK_HID_KEY_A 0x69  // F14
#define VIBESTICK_HID_KEY_B 0x6A  // F15

// Attach the HID service to the existing server (call after the VibeStick
// GATT service is created, before advertising starts).
void hidInit(NimBLEServer* pServer);

// Send one key press (pressed=true) or release. No-ops when not connected.
void hidKey(uint8_t keycode, bool pressed);

// Host-configurable Vibe Mic shortcut usages (F13..F24). Invalid values are
// ignored, keeping the corresponding default binding intact.
void hidSetBindings(uint8_t buttonA, uint8_t buttonB);
uint8_t hidKeyForButtonA();
uint8_t hidKeyForButtonB();
