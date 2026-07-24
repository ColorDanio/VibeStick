#include "ble.h"

#include <NimBLEDevice.h>
#include <ArduinoJson.h>

// UUIDs from docs/protocol.md (v2)
static const char* SERVICE_UUID  = "4b1e0001-5a3f-4c8d-9b6e-7f2a1c0d3e5f";
static const char* STATUS_UUID   = "4b1e0002-5a3f-4c8d-9b6e-7f2a1c0d3e5f";
static const char* SESSIONS_UUID = "4b1e0003-5a3f-4c8d-9b6e-7f2a1c0d3e5f";
static const char* INPUT_UUID    = "4b1e0004-5a3f-4c8d-9b6e-7f2a1c0d3e5f";
static const char* COMMAND_UUID  = "4b1e0005-5a3f-4c8d-9b6e-7f2a1c0d3e5f";
static const char* TOOLS_UUID    = "4b1e0006-5a3f-4c8d-9b6e-7f2a1c0d3e5f";
static const char* VOICE_UUID    = "4b1e0007-5a3f-4c8d-9b6e-7f2a1c0d3e5f";
static const char* AUDIO_UUID    = "4b1e0008-5a3f-4c8d-9b6e-7f2a1c0d3e5f";

StatusInfo gStatus = {};
SessionsInfo gSessions = {};
ToolsInfo gTools = {};
VoiceInfo gVoice = {};

volatile bool gStatusDirty = false;
volatile bool gSessionsDirty = false;
volatile bool gToolsDirty = false;
volatile bool gVoiceDirty = false;
volatile bool gConnDirty = false;
volatile bool gStatusTailOnly = false;
volatile bool gTailChanged = false;

static NimBLECharacteristic* pInputChar = nullptr;
static NimBLECharacteristic* pCommandChar = nullptr;
static NimBLECharacteristic* pAudioChar = nullptr;
static bool sConnected = false;

bool bleConnected() { return sConnected; }

static void notifyJson(NimBLECharacteristic* ch, const char* json) {
  if (!sConnected || ch == nullptr) return;
  Serial.printf("[BLE] tx: %s\n", json);
  ch->setValue((const uint8_t*)json, strlen(json));
  ch->notify();
}

void bleNotifyMessage(const char* text) {
  char buf[256];
  snprintf(buf, sizeof(buf),
           "{\"type\":\"message\",\"text\":\"%s\",\"source\":\"voice\"}", text);
  notifyJson(pInputChar, buf);
}

void bleNotifyCommand(const char* cmd, const char* key, const char* val) {
  char buf[128];
  if (key != nullptr && val != nullptr) {
    snprintf(buf, sizeof(buf), "{\"cmd\":\"%s\",\"%s\":\"%s\"}", cmd, key, val);
  } else {
    snprintf(buf, sizeof(buf), "{\"cmd\":\"%s\"}", cmd);
  }
  notifyJson(pCommandChar, buf);
}

void bleNotifyAudio(const uint8_t* data, size_t len) {
  if (!sConnected || pAudioChar == nullptr || len == 0) return;
  pAudioChar->setValue(data, len);
  pAudioChar->notify();
}

// ---- Callbacks ----

class ServerCB : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* pServer) override {
    sConnected = true;
    gConnDirty = true;
    Serial.println("[BLE] host connected");
  }
  void onDisconnect(NimBLEServer* pServer) override {
    sConnected = false;
    gConnDirty = true;
    Serial.println("[BLE] host disconnected, advertising");
    NimBLEDevice::startAdvertising();
  }
};

// FNV-1a over all tail lines: detects content changes for partial redraws.
static uint32_t tailHash(const StatusInfo& s) {
  uint32_t h = 2166136261u;
  for (int i = 0; i < s.tailCount; ++i) {
    for (const char* p = s.tail[i]; *p; ++p) {
      h ^= (uint8_t)*p;
      h *= 16777619u;
    }
    h ^= 0xFF;
    h *= 16777619u;
  }
  return h;
}

// Defensive cleanup of display text (the daemon pre-cleans, but be safe):
// strip <...> tags, '*' and '`' emphasis, and collapse [text](url) -> text.
static void sanitizeTailLine(char* s) {
  char out[TAIL_LINE_LEN];
  size_t o = 0;
  for (size_t i = 0; s[i] != '\0' && o < sizeof(out) - 1;) {
    if (s[i] == '<') {
      const char* e = strchr(s + i, '>');
      if (e != nullptr) {
        i = (size_t)(e - s) + 1;
        continue;
      }
    }
    if (s[i] == '*' || s[i] == '`') {
      ++i;
      continue;
    }
    if (s[i] == '[') {
      const char* cb = strchr(s + i, ']');
      if (cb != nullptr && cb[1] == '(') {
        const char* cp = strchr(cb + 2, ')');
        if (cp != nullptr) {
          for (const char* p = s + i + 1; p < cb && o < sizeof(out) - 1; ++p)
            out[o++] = *p;
          i = (size_t)(cp - s) + 1;
          continue;
        }
      }
    }
    out[o++] = s[i++];
  }
  out[o] = '\0';
  strcpy(s, out);
}

class StatusCB : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* pChar) override {
    JsonDocument doc;
    if (deserializeJson(doc, pChar->getValue().c_str())) return;

    // Snapshot meta fields to classify the update afterwards (static:
    // StatusInfo is ~1.3 KB, too big for the NimBLE host task stack).
    bool wasValid = gStatus.valid;
    static StatusInfo prev;
    prev = gStatus;

    strlcpy(gStatus.tool, doc["tool"] | "", sizeof(gStatus.tool));
    strlcpy(gStatus.model, doc["model"] | "", sizeof(gStatus.model));
    strlcpy(gStatus.session, doc["session"] | "", sizeof(gStatus.session));
    strlcpy(gStatus.state, doc["state"] | "idle", sizeof(gStatus.state));
    strlcpy(gStatus.last, doc["last"] | "", sizeof(gStatus.last));
    gStatus.ctxPct = doc["ctx_pct"] | -1;
    gStatus.costUsd = doc["cost_usd"] | -1.0f;

    // v2.2 tail: recent conversation lines, oldest first. Defensive caps.
    gStatus.tailCount = 0;
    for (JsonVariant line : doc["tail"].as<JsonArray>()) {
      if (gStatus.tailCount >= TAIL_MAX) break;
      const char* s = line.as<const char*>();
      if (s == nullptr) continue;
      strlcpy(gStatus.tail[gStatus.tailCount], s, TAIL_LINE_LEN);
      sanitizeTailLine(gStatus.tail[gStatus.tailCount]);
      ++gStatus.tailCount;
    }
    gStatus.valid = true;
    gStatusDirty = true;

    bool metaChanged = !wasValid || strcmp(prev.tool, gStatus.tool) ||
                       strcmp(prev.model, gStatus.model) ||
                       strcmp(prev.session, gStatus.session) ||
                       strcmp(prev.state, gStatus.state) ||
                       strcmp(prev.last, gStatus.last) ||
                       prev.ctxPct != gStatus.ctxPct ||
                       prev.costUsd != gStatus.costUsd;
    bool tailChanged =
        !wasValid || prev.tailCount != gStatus.tailCount ||
        tailHash(prev) != tailHash(gStatus);
    gTailChanged = tailChanged;
    gStatusTailOnly = !metaChanged && tailChanged && prev.tailCount > 0 &&
                      gStatus.tailCount > 0;
    if (gStatusTailOnly) Serial.println("[BLE] tail-only update");
  }
};

class SessionsCB : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* pChar) override {
    JsonDocument doc;
    if (deserializeJson(doc, pChar->getValue().c_str())) return;

    gSessions.count = 0;
    gSessions.active = doc["active"] | 0;
    for (JsonObject s : doc["list"].as<JsonArray>()) {
      if (gSessions.count >= 8) break;
      SessionEntry& e = gSessions.list[gSessions.count++];
      strlcpy(e.id, s["id"] | "", sizeof(e.id));
      strlcpy(e.tool, s["tool"] | "", sizeof(e.tool));
      strlcpy(e.name, s["name"] | "", sizeof(e.name));
      strlcpy(e.state, s["state"] | "", sizeof(e.state));
      e.fg = s["fg"] | false;
    }
    gSessions.valid = true;
    gSessionsDirty = true;
  }
};

class ToolsCB : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* pChar) override {
    JsonDocument doc;
    if (deserializeJson(doc, pChar->getValue().c_str())) return;

    gTools.count = 0;
    gTools.active = doc["active"] | 0;
    for (JsonObject t : doc["list"].as<JsonArray>()) {
      if (gTools.count >= TOOL_MAX) break;
      ToolEntry& e = gTools.list[gTools.count++];
      strlcpy(e.id, t["id"] | "", sizeof(e.id));
      strlcpy(e.name, t["name"] | "", sizeof(e.name));
      strlcpy(e.state, t["state"] | "idle", sizeof(e.state));
      e.fnCount = 0;
      for (JsonVariant f : t["fns"].as<JsonArray>()) {
        if (e.fnCount >= FN_MAX) break;
        strlcpy(e.fns[e.fnCount++], f.as<const char*>() ?: "",
                sizeof(e.fns[0]));
      }
    }
    gTools.valid = true;
    gToolsDirty = true;
  }
};

class VoiceCB : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* pChar) override {
    JsonDocument doc;
    if (deserializeJson(doc, pChar->getValue().c_str())) return;

    strlcpy(gVoice.state, doc["state"] | "idle", sizeof(gVoice.state));
    strlcpy(gVoice.text, doc["text"] | "", sizeof(gVoice.text));
    gVoice.valid = true;
    gVoiceDirty = true;
  }
};

// ---- Setup ----

void bleInit() {
  NimBLEDevice::init("VibeStick");
  NimBLEDevice::setMTU(247);
  NimBLEDevice::setPower(ESP_PWR_LVL_P9);

  NimBLEServer* pServer = NimBLEDevice::createServer();
  pServer->setCallbacks(new ServerCB());

  NimBLEService* pService = pServer->createService(SERVICE_UUID);

  NimBLECharacteristic* pStatus =
      pService->createCharacteristic(STATUS_UUID, NIMBLE_PROPERTY::WRITE);
  pStatus->setCallbacks(new StatusCB());

  NimBLECharacteristic* pSessions =
      pService->createCharacteristic(SESSIONS_UUID, NIMBLE_PROPERTY::WRITE);
  pSessions->setCallbacks(new SessionsCB());

  NimBLECharacteristic* pTools =
      pService->createCharacteristic(TOOLS_UUID, NIMBLE_PROPERTY::WRITE);
  pTools->setCallbacks(new ToolsCB());

  NimBLECharacteristic* pVoice =
      pService->createCharacteristic(VOICE_UUID, NIMBLE_PROPERTY::WRITE);
  pVoice->setCallbacks(new VoiceCB());

  pInputChar = pService->createCharacteristic(INPUT_UUID, NIMBLE_PROPERTY::NOTIFY);
  pCommandChar = pService->createCharacteristic(COMMAND_UUID, NIMBLE_PROPERTY::NOTIFY);
  pAudioChar = pService->createCharacteristic(AUDIO_UUID, NIMBLE_PROPERTY::NOTIFY);

  pService->start();

  NimBLEAdvertising* pAdv = NimBLEDevice::getAdvertising();
  pAdv->addServiceUUID(SERVICE_UUID);
  pAdv->setScanResponse(true);  // device name goes in the scan response
  pAdv->start();

  Serial.println("[BLE] init done, advertising as 'VibeStick'");
}
