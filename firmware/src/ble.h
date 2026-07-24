#pragma once

#include <Arduino.h>

// ---- Shared state (populated by BLE writes, read by the UI/app) ----
// Written from the NimBLE host task; the app consumes the *Dirty flags in
// loop() and redraws there, so the LCD is only ever touched from loop().

#define TAIL_MAX 8        // defensive cap on tail lines
#define TAIL_LINE_LEN 128 // defensive cap per line (bytes)

struct StatusInfo {
  char tool[24];
  char model[24];
  char session[32];
  char state[12];
  int ctxPct;     // -1 = unknown
  float costUsd;  // < 0 = unknown
  char last[96];
  // v2.2: recent conversation lines of the selected session, oldest first.
  // tailCount == 0 -> fall back to `last`.
  char tail[TAIL_MAX][TAIL_LINE_LEN];
  int tailCount;
  bool valid;
};

struct SessionEntry {
  char id[12];
  char tool[16];
  char name[32];
  char state[12];
  bool fg;  // v2.1: session is live in the foreground (green dot)
};

struct SessionsInfo {
  SessionEntry list[8];
  int count;
  int active;
  bool valid;
};

#define TOOL_MAX 6
#define FN_MAX 8

struct ToolEntry {
  char id[20];
  char name[24];
  char state[12];
  char fns[FN_MAX][20];
  int fnCount;
};

struct ToolsInfo {
  ToolEntry list[TOOL_MAX];
  int count;
  int active;
  bool valid;
};

struct VoiceInfo {
  char state[16];  // idle | recording | transcribing | ready | error
  char text[200];
  bool valid;
};

extern StatusInfo gStatus;
extern SessionsInfo gSessions;
extern ToolsInfo gTools;
extern VoiceInfo gVoice;

// Set by BLE callbacks (NimBLE task), cleared by the app in loop().
extern volatile bool gStatusDirty;
extern volatile bool gSessionsDirty;
extern volatile bool gToolsDirty;
extern volatile bool gVoiceDirty;
extern volatile bool gConnDirty;  // connection state changed
// Set together with gStatusDirty when ONLY the tail lines changed (meta
// fields identical, tail present before and after): the app can redraw
// just the conversation content area instead of the whole screen.
extern volatile bool gStatusTailOnly;
// Set on any STATUS push where the tail content actually changed (the app
// snaps the reading position back to the newest message).
extern volatile bool gTailChanged;

// ---- BLE API ----

void bleInit();
bool bleConnected();

// INPUT characteristic: {"type":"message","text":"...","source":"voice"}
void bleNotifyMessage(const char* text);

// COMMAND characteristic: {"cmd":"..."} or {"cmd":"...","<key>":"<val>"}
// e.g. key="id" for tool.select/session.select, key="fn" for fn.activate.
void bleNotifyCommand(const char* cmd, const char* key = nullptr,
                      const char* val = nullptr);

// AUDIO characteristic: binary PCM chunk (8 kHz, 8-bit unsigned, mono).
void bleNotifyAudio(const uint8_t* data, size_t len);
