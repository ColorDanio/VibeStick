#include "hid.h"

#include <NimBLEDevice.h>
#include <NimBLEHIDDevice.h>

#include "ble.h"

// Standard boot-keyboard report, extended to usage max 0x73 (F13-F24) so
// F19/F20 fit. Report: 8 bytes = modifiers, reserved, 6 key slots.
static const uint8_t sReportMap[] = {
    0x05, 0x01,  // Usage Page (Generic Desktop)
    0x09, 0x06,  // Usage (Keyboard)
    0xA1, 0x01,  // Collection (Application)
    0x85, 0x01,  //   Report ID (1)
    0x05, 0x07,  //   Usage Page (Key Codes)
    0x19, 0xE0,  //   Usage Minimum (224)
    0x29, 0xE7,  //   Usage Maximum (231)
    0x15, 0x00,  //   Logical Minimum (0)
    0x25, 0x01,  //   Logical Maximum (1)
    0x75, 0x01,  //   Report Size (1)
    0x95, 0x08,  //   Report Count (8)
    0x81, 0x02,  //   Input (Data, Variable, Absolute)  ; modifiers
    0x95, 0x01,  //   Report Count (1)
    0x75, 0x08,  //   Report Size (8)
    0x81, 0x01,  //   Input (Constant)                  ; reserved
    0x95, 0x06,  //   Report Count (6)
    0x75, 0x08,  //   Report Size (8)
    0x15, 0x00,  //   Logical Minimum (0)
    0x25, 0x73,  //   Logical Maximum (115)             ; up to F24
    0x05, 0x07,  //   Usage Page (Key Codes)
    0x19, 0x00,  //   Usage Minimum (0)
    0x29, 0x73,  //   Usage Maximum (115)
    0x81, 0x00,  //   Input (Data, Array)
    0xC0,        // End Collection
};

static NimBLECharacteristic* sInput = nullptr;

void hidInit(NimBLEServer* pServer) {
  NimBLEDevice::setSecurityAuth(true, false, false);  // bonding, legacy pairing
  NimBLEDevice::setSecurityIOCap(BLE_HS_IO_NO_INPUT_OUTPUT);  // just works
  NimBLEDevice::setSecurityInitKey(BLE_SM_PAIR_KEY_DIST_ENC |
                                   BLE_SM_PAIR_KEY_DIST_ID);
  NimBLEDevice::setSecurityRespKey(BLE_SM_PAIR_KEY_DIST_ENC |
                                   BLE_SM_PAIR_KEY_DIST_ID);

  NimBLEHIDDevice* hid = new NimBLEHIDDevice(pServer);
  hid->manufacturer("M5Stack");
  hid->pnp(0x01, 0x02AC, 0x0001, PNPVersionField(2, 2, 0));
  hid->reportMap((uint8_t*)sReportMap, sizeof(sReportMap));
  // HID Information characteristic (0x2a4a) is created empty by the
  // library; BlueZ's hog-lib refuses to set up the profile without it.
  // v1.11, country 0, flags: remote-wake + normally-connectable.
  hid->hidInfo(0x00, 0x03);
  hid->startServices();
  sInput = hid->inputReport(1);
  Serial.println("[HID] keyboard service up (A=F19, B=F20)");
}

void hidKey(uint8_t keycode, bool pressed) {
  if (!bleConnected() || sInput == nullptr) return;
  uint8_t report[8] = {0};
  if (pressed) report[2] = keycode;
  sInput->setValue(report, sizeof(report));
  sInput->notify();
  Serial.printf("[HID] %s %s\n", keycode == VIBESTICK_HID_KEY_A ? "F19" : "F20",
                pressed ? "press" : "release");
}
