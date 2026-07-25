#include "board.h"


#include <esp_task_wdt.h>

#include "ble.h"
#include "mic.h"
#include "ui.h"


// VibeStick firmware v2.2: BLE display + input terminal for AI CLI
// sessions. See docs/protocol.md, "Interaction model (device UX, v2.1)".
//
// Session-centric flow over fake-CLI screens:
//   home (tool picker) -> session picker -> conversation
//
// Buttons (short < 800 ms <= long):
//   home:            B = next tool (slide animation), A = select tool
//   session picker:  B = next entry,         A = enter (new session / select)
//   conversation:    hold A >=500 ms = record (voice.start), release = stop
//                    (voice.stop); transcript ready: A = send, B = discard;
//                    thinking/running: A = inference.cancel;
//                    otherwise A/B = scroll content down/up
//   anywhere:        B long = back one level; shake = refresh
//   power key:       short press = back one level, double press = home
//   idle 60 s = display dim (wake on button/motion); display auto-rotates
//   portrait/landscape from the IMU gravity vector (locked while recording)

#define PIN_LED 10  // red LED, active low
#define LONG_PRESS_MS 800
#define DBL_CLICK_MS 400
#define REC_HOLD_MS 500
#define REC_MAX_MS 20000
#define SEND_MARK_MS 30000
#define DIM_AFTER_MS 60000
#define AUDIO_CHUNK 180
#define AUDIO_CHUNKS_PER_LOOP 3

static const char* SCREEN_NAMES[] = {"waiting", "home", "sessions", "convo",
                                     "mic"};

enum Screen { SCR_WAITING, SCR_HOME, SCR_SESSIONS, SCR_CONVO, SCR_MIC };

enum Event { EV_NONE, EV_A_SHORT, EV_A_LONG, EV_A_DBL, EV_B_SHORT, EV_B_LONG };

static Screen sScreen = SCR_WAITING;
static int sSelTool = 0;
static int sSelEntry = 0;  // session picker: 0 = "+ new session", 1..n list
static int sWaitPhase = 0;
// Optimistic home navigation: host TOOLS pushes may not override the local
// selection while this window is open (extended on every B press).
static uint32_t sNavUntil = 0;
#define NAV_SYNC_MS 3000

static bool sRecording = false;
static uint32_t sRecStart = 0;
static bool sRecAutoStopped = false;  // 20 s cap fired while A still held

// After voice.confirm: wait for the next STATUS to resolve queue/thinking.
static bool sSendMark = false;
static bool sSentBusy = false;
static uint32_t sSendMarkAt = 0;

// Recent voice-pipeline error (kept visible ~3 s so a following idle push
// can't wipe it immediately).
static char sErrorText[80] = "";
static uint32_t sErrorAt = 0;
#define ERROR_VISIBLE_MS 3000

static const char* visibleError() {
  return (sErrorAt != 0 && millis() - sErrorAt < ERROR_VISIBLE_MS)
             ? sErrorText
             : nullptr;
}

static bool sNeedRedraw = true;

static uint32_t sLastActivity = 0;
static bool sDimmed = false;
static bool sSwallowGesture = false;  // button press that only wakes the screen

static int sBatteryPct = -1;
static uint32_t sBatNext = 0;


// ---- event queue ----

static Event sQueue[8];
static volatile int sQHead = 0, sQTail = 0;

static void pushEvent(Event e) {
  int next = (sQHead + 1) % 8;
  if (next == sQTail) return;  // full: drop
  sQueue[sQHead] = e;
  sQHead = next;
}

static bool popEvent(Event* e) {
  if (sQTail == sQHead) return false;
  *e = sQueue[sQTail];
  sQTail = (sQTail + 1) % 8;
  return true;
}

// ---- helpers ----

static void setScreen(Screen s) {
  if (sScreen == s) return;
  Serial.printf("[UI] screen: %s -> %s\n", SCREEN_NAMES[sScreen],
                SCREEN_NAMES[s]);
  sScreen = s;
  sNeedRedraw = true;
  uiMarqueeResetAll();  // no stale band may paint over the new screen
  uiConvoPageReset();
}

static void activity() {
  sLastActivity = millis();
  if (sDimmed) {
    sDimmed = false;
    boardBrightness(80);
    sNeedRedraw = true;
  }
}

static void startRecording(bool micMode) {
  // v2.1: mode "mic" = raw voice-input microphone (host forwards PCM to a virtual
  // mic); no mode = the normal ASR voice flow. Old hosts ignore the key.
  if (micMode) {
    bleNotifyCommand("voice.start", "mode", "mic");
    Serial.println("[VOICE] recording started (mode=mic)");
  } else {
    bleNotifyCommand("voice.start");
    Serial.println("[VOICE] recording started");
  }
  micStart();
  sRecording = true;
  sRecStart = millis();
  sNeedRedraw = true;
}

static void stopRecording() {
  sRecording = false;
  micStop();
  bleNotifyCommand("voice.stop");
  sNeedRedraw = true;
  Serial.println("[VOICE] recording stopped");
}

static bool transcriptPending() {
  if (!gVoice.valid) return false;
  return strcmp(gVoice.state, "ready") == 0 ||
         strcmp(gVoice.state, "transcribing") == 0;
}

// Leave the conversation: stop any recording, discard a pending transcript.
static void leaveConvo() {
  if (sRecording) stopRecording();
  if (transcriptPending()) bleNotifyCommand("voice.cancel");
  sSendMark = false;
}

static void redraw() {
  switch (sScreen) {
    case SCR_WAITING: uiShowWaiting(sWaitPhase); break;
    case SCR_HOME: uiShowHome(sSelTool); break;
    case SCR_SESSIONS: uiShowSessionPicker(sSelEntry); break;
    case SCR_CONVO:
      if (sRecording) {
        uiShowRecording(micLevel(), millis() - sRecStart);
      } else {
        uiShowConvo(sSendMark, sSentBusy, visibleError());
      }
      break;
    case SCR_MIC:
      if (sRecording) {
        uiShowRecording(micLevel(), millis() - sRecStart);
      } else {
        uiShowMic(visibleError());
      }
      break;
  }
}

// ---- button event handling ----

static void back() {  // one level up
  switch (sScreen) {
    case SCR_CONVO:
      leaveConvo();
      setScreen(SCR_SESSIONS);
      break;
    case SCR_SESSIONS:
      setScreen(SCR_HOME);
      break;
    case SCR_MIC:
      if (sRecording) stopRecording();  // no transcript states: nothing to cancel
      setScreen(SCR_HOME);
      break;
    default:
      break;  // home / waiting: no-op
  }
}

static void handleEvent(Event e) {
  // Long B anywhere: back one level.
  if (e == EV_B_LONG) {
    back();
    return;
  }

  switch (sScreen) {
    case SCR_WAITING:
      break;  // no input until host data arrives

    case SCR_HOME: {
      int toolCount = gTools.valid ? gTools.count : 0;
      int entries = toolCount + 1;  // + device-local Microphone entry
      if (e == EV_B_SHORT) {
        int from = sSelTool;
        sSelTool = (sSelTool + 1) % entries;  // optimistic: move instantly
        sNavUntil = millis() + NAV_SYNC_MS;   // host sync yields while nav
        // Keep the host's active tool in sync only for real tools; the mic
        // entry is device-local and has no host counterpart.
        if (sSelTool < toolCount) bleNotifyCommand("tool.next");
        Serial.printf("[UI] home select -> %d/%d\n", sSelTool, entries - 1);
        uiHomeAnimate(from, sSelTool);
      } else if (e == EV_A_SHORT) {
        if (sSelTool >= toolCount) {
          setScreen(SCR_MIC);  // device-local voice-input microphone
        } else {
          bleNotifyCommand("tool.select", "id", gTools.list[sSelTool].id);
          sSelEntry = gSessions.valid ? gSessions.active + 1 : 0;
          setScreen(SCR_SESSIONS);
        }
      }
      break;
    }

    case SCR_SESSIONS: {
      int entries = 1 + (gSessions.valid ? gSessions.count : 0);
      if (e == EV_B_SHORT) {
        sSelEntry = (sSelEntry + 1) % entries;
        sNeedRedraw = true;
      } else if (e == EV_A_SHORT) {
        if (sSelEntry == 0) {
          bleNotifyCommand("session.new");
        } else if (gSessions.valid && sSelEntry <= gSessions.count) {
          bleNotifyCommand("session.select", "id",
                           gSessions.list[sSelEntry - 1].id);
        }
        setScreen(SCR_CONVO);
      }
      break;
    }

    case SCR_CONVO:
      if (e == EV_A_SHORT) {
        bool ready = gVoice.valid && strcmp(gVoice.state, "ready") == 0;
        bool running =
            gStatus.valid && strcmp(gStatus.state, "running") == 0;
        if (ready) {
          // transcript ready -> send, back to reading at the newest
          bleNotifyCommand("voice.confirm");
          sSendMark = true;
          sSentBusy = running;  // busy session -> acts as a queue
          sSendMarkAt = millis();
          uiConvoPageReset();
          Serial.printf("[VOICE] confirm sent (session %s)\n",
                        running ? "busy -> queue" : "idle -> wait thinking");
          sNeedRedraw = true;
        } else if (sSendMark || running) {
          // thinking / running -> cancel inference
          bleNotifyCommand("inference.cancel");
          sSendMark = false;
          Serial.println("[CMD] inference.cancel");
          sNeedRedraw = true;
        } else {
          uiConvoPage(-1);  // older message, partial redraw
        }
      } else if (e == EV_A_DBL) {
        if (gVoice.valid && strcmp(gVoice.state, "ready") == 0) {
          // discard the transcript, back to reading
          bleNotifyCommand("voice.cancel");
          Serial.println("[VOICE] transcript dropped (dbl-A)");
        }
        // jump to the newest message either way
        uiConvoPage(TAIL_MAX);
      } else if (e == EV_B_SHORT) {
        if (transcriptPending()) {
          // pending transcript -> discard (re-record)
          bleNotifyCommand("voice.cancel");
          sNeedRedraw = true;
        } else {
          uiConvoPage(+1);  // newer message, partial redraw
        }
      }
      break;
  }
}

// ---- raw button tracking ----

static uint32_t sADownAt = 0;
static uint32_t sBDownAt = 0;
static bool sAwaitSecondClick = false;
static bool sPendingSingle = false;  // deferred click (transcript-send)
static uint32_t sFirstClickAt = 0;

static void pollButtons() {
  bool convo = (sScreen == SCR_CONVO);
  bool holdTalk = convo || (sScreen == SCR_MIC);  // hold-to-record screens

  if (boardBtnA_wasPressed()) {
    if (sDimmed) sSwallowGesture = true;  // wake-only gesture
    activity();
    sADownAt = millis();
  }
  if (boardBtnB_wasPressed()) {
    if (sDimmed) sSwallowGesture = true;
    activity();
    sBDownAt = millis();
  }

  if (boardBtnA_wasReleased() && sADownAt != 0) {
    uint32_t dur = millis() - sADownAt;
    sADownAt = 0;
    if (sSwallowGesture && !boardBtnA_isPressed() && !boardBtnB_isPressed()) {
      sSwallowGesture = false;
    } else if (!sSwallowGesture) {
      if (holdTalk) {
        // Hold-to-record: release stops. Conversation clicks: page actions
        // fire immediately; a transcript-send waits out the 400 ms window
        // because double-click means "discard" there (ambiguity). MIC mode
        // ignores clicks (pure hold-to-talk).
        if (sRecAutoStopped) {
          sRecAutoStopped = false;  // release after the 20 s cap: no click
        } else if (sRecording) {
          stopRecording();
        } else if (convo) {
          bool ready =
              gVoice.valid && strcmp(gVoice.state, "ready") == 0;
          if (sAwaitSecondClick &&
              millis() - sFirstClickAt < DBL_CLICK_MS) {
            sAwaitSecondClick = false;
            sPendingSingle = false;
            pushEvent(EV_A_DBL);
          } else if (ready) {
            sAwaitSecondClick = true;
            sPendingSingle = true;  // confirm fires when the window expires
            sFirstClickAt = millis();
          } else {
            sAwaitSecondClick = true;
            sFirstClickAt = millis();
            pushEvent(EV_A_SHORT);
          }
        }
      } else {
        pushEvent(dur >= LONG_PRESS_MS ? EV_A_LONG : EV_A_SHORT);
      }
    }
  }

  if (boardBtnB_wasReleased() && sBDownAt != 0) {
    uint32_t dur = millis() - sBDownAt;
    sBDownAt = 0;
    if (sSwallowGesture && !boardBtnA_isPressed() && !boardBtnB_isPressed()) {
      sSwallowGesture = false;
    } else if (!sSwallowGesture) {
      pushEvent(dur >= LONG_PRESS_MS ? EV_B_LONG : EV_B_SHORT);
    }
  }

  // Double-click window expired: fire a deferred single action (the
  // transcript-send case above).
  if (sAwaitSecondClick && millis() - sFirstClickAt >= DBL_CLICK_MS) {
    sAwaitSecondClick = false;
    if (sPendingSingle) {
      sPendingSingle = false;
      pushEvent(EV_A_SHORT);
    }
  }
}

// ---- IMU: double-shake = refresh, motion = wake, orientation ----

static float sPrevAx = 0, sPrevAy = 0, sPrevAz = 1;
static bool sImuPrimed = false;
static uint32_t sImuNext = 0;
static uint32_t sLastPulseAt = 0;
static uint32_t sShakeCooldownUntil = 0;

// Current LCD rotation (0=portrait, 1=landscape, 2/3=flipped) and the
// candidate orientation pending confirmation (hysteresis).
static uint8_t sOrientation = 1;
static uint8_t sCandOrientation = 1;
static uint32_t sCandSince = 0;
#define ORIENT_STABLE_MS 500

// MPU6886 axes on the M5StickC Plus: +Y points toward the device top,
// +X toward the right side. Pick the closest of the 4 rotations.
static uint8_t orientationFromAccel(float ax, float ay) {
  if (fabsf(ay) >= fabsf(ax)) return ay >= 0 ? 0 : 2;  // portrait
  return ax >= 0 ? 1 : 3;                             // landscape
}

static void pollImu() {
  uint32_t now = millis();
  if (now < sImuNext) return;
  sImuNext = now + 50;

  float ax, ay, az;
  boardGetAccel(&ax, &ay, &az);
  if (!sImuPrimed) {
    sPrevAx = ax; sPrevAy = ay; sPrevAz = az;
    sImuPrimed = true;
    return;
  }
  float dx = ax - sPrevAx, dy = ay - sPrevAy, dz = az - sPrevAz;
  sPrevAx = ax; sPrevAy = ay; sPrevAz = az;
  float jerk = sqrtf(dx * dx + dy * dy + dz * dz);

  if (jerk > 0.15f) activity();  // motion wakes the display

  // Conservative shake pulse: sharp jerk, 200 ms refractory between pulses.
  if (jerk > 1.8f && now - sLastPulseAt > 200) {
    if (now > sShakeCooldownUntil && now - sLastPulseAt < 700) {
      // Second pulse within 700 ms = double-shake.
      sShakeCooldownUntil = now + 3000;
      Serial.println("[IMU] double-shake -> refresh");
      bleNotifyCommand("refresh");
    }
    sLastPulseAt = now;
  }

  // Orientation: candidate must stay stable ORIENT_STABLE_MS before we
  // rotate. Locked while recording so the screen can't flip mid-gesture.
  // When the device is ~flat (gravity mostly on Z) keep the current
  // orientation — the X/Y comparison would be pure noise.
  if (fabsf(ax) < 0.5f && fabsf(ay) < 0.5f) {
    sCandSince = now;
  } else {
    uint8_t cand = orientationFromAccel(ax, ay);
    if (cand != sCandOrientation) {
      sCandOrientation = cand;
      sCandSince = now;
    }
    if (cand != sOrientation && !sRecording &&
        now - sCandSince >= ORIENT_STABLE_MS) {
      sOrientation = cand;
      uiSetOrientation(cand);
      sNeedRedraw = true;
      Serial.printf("[UI] orientation change -> rotation %d (%dx%d)\n",
                    sOrientation, (cand % 2 == 0) ? 135 : 240,
                    (cand % 2 == 0) ? 240 : 135);
    }
  }
}

// ---- battery ----

static void pollBattery(bool force) {
  uint32_t now = millis();
  if (!force && now < sBatNext) return;
  sBatNext = now + 15000;

  int pct = boardBatteryPct();
  if (pct != sBatteryPct) {
    sBatteryPct = pct;
    uiSetBatteryPct(pct);
    sNeedRedraw = true;
  }
}

// ---- BLE state application ----

static void applyBleDirty() {
  if (gConnDirty) {
    gConnDirty = false;
    if (!bleConnected()) {
      if (sRecording) stopRecording();
      setScreen(SCR_WAITING);
    } else if (sScreen == SCR_WAITING) {
      setScreen(SCR_HOME);
    }
    sNeedRedraw = true;
  }
  if (gToolsDirty) {
    gToolsDirty = false;
    if (gTools.count > 0) {
      // Follow the host's active tool only while the user is not
      // navigating locally (optimistic UI: B presses win for NAV_SYNC_MS).
      bool userNav = millis() < sNavUntil;
      if (!userNav) {
        sSelTool = gTools.active;
        if (sSelTool < 0 || sSelTool > gTools.count) sSelTool = 0;
      }
      if (sScreen == SCR_WAITING) setScreen(SCR_HOME);
      else if (sScreen == SCR_HOME && !userNav) sNeedRedraw = true;
    } else if (sScreen == SCR_HOME) {
      sNeedRedraw = true;
    }
  }
  if (gStatusDirty) {
    gStatusDirty = false;
    // Resolve the post-send footer: a busy session leaves "queue" on the
    // next STATUS push; an idle session switches to "thinking" once the
    // host reports running.
    if (sSendMark &&
        (sSentBusy || strcmp(gStatus.state, "running") == 0)) {
      sSendMark = false;
      gStatusTailOnly = false;  // footer changes need the full redraw
    }
    // New tail content: live-follow only when already at the newest page;
    // a user paging through history keeps their position (refresh-safe).
    if (gTailChanged) uiConvoTailSync();
    gTailChanged = false;
    if (sScreen == SCR_CONVO) {
      if (gStatusTailOnly) {
        // Only the tail lines changed: erase+redraw the content area,
        // no full-screen redraw (no flicker).
        gStatusTailOnly = false;
        if (!sDimmed && !sRecording) uiRedrawConvoTail();
      } else {
        sNeedRedraw = true;
      }
    }
    gStatusTailOnly = false;
  }
  if (gSessionsDirty) {
    gSessionsDirty = false;
    if (sScreen == SCR_SESSIONS) {
      int entries = 1 + gSessions.count;
      if (sSelEntry >= entries) sSelEntry = entries - 1;
      sNeedRedraw = true;
    }
  }
  if (gVoiceDirty) {
    gVoiceDirty = false;
    if (gVoice.valid && strcmp(gVoice.state, "error") == 0) {
      strlcpy(sErrorText, gVoice.text[0] ? gVoice.text : "voice error",
              sizeof(sErrorText));
      sErrorAt = millis();
      Serial.printf("[VOICE] error: %s\n", sErrorText);
    }
    if (sScreen == SCR_CONVO || sScreen == SCR_MIC) sNeedRedraw = true;
  }
}


// ---- power button (AXP192 PEK) ----
//
// boardPowerButtonEvent() returns AXP192 IRQ status reg 0x46 and clears it.
// On this unit: 0 = none, 1 = long press (>=2 s), 2 = short press.
// Short press = back one level; double press (two short presses within
// 400 ms) = home. Long press is ignored (the PMU owns power-off).

static bool sPowerAwaitSecond = false;
static uint32_t sPowerFirstAt = 0;

static void powerHome() {
  if (sScreen == SCR_CONVO) leaveConvo();
  else if (sScreen == SCR_MIC && sRecording) stopRecording();
  setScreen(SCR_HOME);
}

static void pollPowerButton() {
  uint32_t now = millis();
  uint8_t btn = boardPowerButtonEvent();
  if (btn != 0) {
    Serial.printf("[PWR] power button event: %d\n", btn);
    activity();
  }
  if (btn == 2) {
    if (sPowerAwaitSecond && now - sPowerFirstAt < DBL_CLICK_MS) {
      sPowerAwaitSecond = false;
      Serial.println("[PWR] double press -> home");
      powerHome();
    } else {
      sPowerAwaitSecond = true;
      sPowerFirstAt = now;
    }
  }
  if (sPowerAwaitSecond && now - sPowerFirstAt >= DBL_CLICK_MS) {
    sPowerAwaitSecond = false;
    Serial.println("[PWR] short press -> back");
    back();
  }
}

// ---- status LED: off when connected, slow blink when advertising ----

static void pollLed() {
#ifdef VIBESTICK_BOARD_S3
  // no user LED documented on StickS3
#else
  if (bleConnected()) {
    digitalWrite(PIN_LED, HIGH);  // off
  } else {
    bool on = (millis() % 1600) < 80;
    digitalWrite(PIN_LED, on ? LOW : HIGH);
  }
#endif
}

// ---- audio streaming ----

static void pumpAudio() {
  if (!sRecording) return;

  if (millis() - sRecStart >= REC_MAX_MS) {
    Serial.println("[VOICE] max recording time reached, auto-stop");
    sRecAutoStopped = true;  // the coming A release is not a click
    stopRecording();
    return;
  }

  uint8_t buf[AUDIO_CHUNK];
  for (int i = 0; i < AUDIO_CHUNKS_PER_LOOP; ++i) {
    size_t n = micRead(buf, sizeof(buf));
    if (n == 0) break;
    bleNotifyAudio(buf, n);
    if (n < sizeof(buf)) break;
  }
}

// ---- Arduino ----


void setup() {
  Serial.begin(115200);
  Serial.println();
  Serial.println("[BOOT] " BOARD_NAME);
  {
    // Reset diagnostics: distinguishes crash-watchdog/brownout/panic from
    // a clean power-on when investigating "jumped back to home" reports.
    static const char* reasons[] = {
        "", "POWERON", "EXT", "SW", "PANIC", "INT_WDT", "TASK_WDT",
        "WDT", "DEEPSLEEP", "BROWNOUT", "SDIO"};
    int r = (int)esp_reset_reason();
    Serial.printf("[BOOT] reset reason: %d (%s)\n", r,
                  (r >= 1 && r <= 10) ? reasons[r] : "?");
  }

#ifndef VIBESTICK_BOARD_S3
  pinMode(PIN_LED, OUTPUT);
  digitalWrite(PIN_LED, HIGH);  // off
#endif

  boardInit();
  Serial.println("[BOOT] board init done");

  uiInit();
  Serial.println("[BOOT] branded waiting screen (until host connects)");

  bleInit();
  micInit();
  sLastActivity = millis();
  pollBattery(true);

  // Freeze insurance: the loop task is not covered by any watchdog in
  // stock Arduino. An 8 s TWDT turns any unknown hang (observed in the
  // field as "screen frozen + no advertising + silent serial forever")
  // into a self-healing panic reset with [BOOT] reset reason evidence.
  esp_task_wdt_init(8, true);  // no-op if the core already initialized it
  esp_task_wdt_add(xTaskGetCurrentTaskHandle());
  Serial.println("[BOOT] loopTask TWDT armed (8 s)");
}

void loop() {
  boardUpdate();
  esp_task_wdt_reset();  // feed the loop watchdog every pass

  pollButtons();


  // Hold-to-record: A held >=500 ms in a hold-to-record screen starts recording.
  if ((sScreen == SCR_CONVO || sScreen == SCR_MIC) && !sRecording &&
      sADownAt != 0 && boardBtnA_isPressed() &&
      millis() - sADownAt >= REC_HOLD_MS) {
    startRecording(sScreen == SCR_MIC);
  }

  Event e;
  while (popEvent(&e)) handleEvent(e);

  applyBleDirty();
#if VIBESTICK_DEBUG_FORCE_CONVO
  // TEMPORARY: exercise the convo render path without physical buttons.
  if (sScreen == SCR_HOME && gStatus.valid &&
      (gStatus.tailCount > 0 || (gVoice.valid && gVoice.text[0]))) {
    setScreen(SCR_CONVO);
  }
#endif
  pollImu();
  pollPowerButton();
  pollBattery(false);
  pollLed();
  bleEnsureAdvertising();
  pumpAudio();
  if (!sDimmed) uiMarqueeTick();  // redraws only moved text bands

  // Home slide animation: per-frame partial redraws; on completion do the
  // full home redraw (name/state/dots/neighbors catch up).
  if (!sDimmed && uiHomeAnimTick()) sNeedRedraw = true;

  // Periodic fallback refresh while on the conversation screen (~10 s).
  // Data-only: never touches the page position or interaction state.
  {
    static uint32_t sRefreshNext = 0;
    if (sScreen == SCR_CONVO && bleConnected() && !sRecording &&
        millis() >= sRefreshNext) {
      sRefreshNext = millis() + 10000;
      bleNotifyCommand("refresh");
    }
  }

  // Send-mark timeout: if no STATUS ever resolves it, drop the footer mark.
  if (sSendMark && millis() - sSendMarkAt > SEND_MARK_MS) {
    sSendMark = false;
    if (sScreen == SCR_CONVO) sNeedRedraw = true;
  }

  // Display idle dim.
  if (!sDimmed && millis() - sLastActivity > DIM_AFTER_MS) {
    sDimmed = true;
    boardBrightness(15);
    Serial.println("[UI] display dimmed (idle)");
  }

  // Animation ticks: partial redraws of dynamic regions only (no
  // full-screen redraw, so no flicker).
  uint32_t now = millis();
  static uint32_t sAnimNext = 0;
  if (now >= sAnimNext && !sDimmed) {
    if (sScreen == SCR_WAITING) {
      sWaitPhase = (sWaitPhase + 1) % 3;
      uiTickWaiting(sWaitPhase);  // ring box + message line only
      sAnimNext = now + 400;
    } else if ((sScreen == SCR_CONVO || sScreen == SCR_MIC) && sRecording) {
      uiTickRecording(micLevel(), millis() - sRecStart);
      sAnimNext = now + 100;
    } else if (sScreen == SCR_CONVO) {
      uiTickConvo();  // transcribing dots only
      sAnimNext = now + 200;
    } else {
      sAnimNext = now + 200;
    }
  }

  if (sNeedRedraw && !sDimmed) {
    sNeedRedraw = false;
    redraw();
  }


  delay(2);
}
