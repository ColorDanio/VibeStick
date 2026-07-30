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

// Send one shortcut press (pressed=true) or release. Modifiers use the HID
// bitmap (Ctrl=0x01, Shift=0x02, Alt=0x04). No-ops when disconnected.
void hidKey(uint8_t keycode, uint8_t modifiers, bool pressed);

// Host-configurable Vibe Mic shortcuts (F1..F24 plus Ctrl/Alt/Shift). Invalid
// values are ignored, keeping the corresponding default binding intact.
void hidSetBindings(uint8_t buttonA, uint8_t modifiersA, uint8_t buttonB,
                    uint8_t modifiersB);
uint8_t hidKeyForButtonA();
uint8_t hidKeyForButtonB();
uint8_t hidModifiersForButtonA();
uint8_t hidModifiersForButtonB();
