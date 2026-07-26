#pragma once

#include <stdint.h>

// Screen renderers. All screens lay out from the current screen size, so
// they work in landscape (240x135, rotation 1/3) and portrait (135x240,
// rotation 0/2). A 16px status bar sits on top of main screens (BLE icon,
// tool name, battery). All drawing happens from loop() only.
//
// Animated elements use partial redraws: uiShowX() draws the static layout
// once; uiTickX() / uiMarqueeTick() erase+redraw only their own regions.

void uiInit();

// Switch LCD rotation (0..3) and update the cached screen size used by
// every layout. Caller must trigger a full redraw afterwards.
void uiSetOrientation(uint8_t rot);

// Battery level shown in the status bar (0-100). Set by the app.
void uiSetBatteryPct(int pct);

// Advance marquee animations (time-based). Moved bands are erased+redrawn
// directly (small regions only) -- never triggers a full-screen redraw.
void uiMarqueeTick();

// Deactivate all marquee slots. Must be called on every screen switch.
void uiMarqueeResetAll();

void uiShowWaiting(int animPhase);     // branded boot/waiting, static draw
void uiTickWaiting(int animPhase);     // rings + message line only
void uiShowHome(int selTool);          // tool picker carousel
// Start a ~150 ms slide animation of the center icon (from -> to).
void uiHomeAnimate(int fromIdx, int toIdx);
// Draw the next animation frame; returns true once on completion (caller
// should then do a full home redraw). Cheap no-op when not animating.
bool uiHomeAnimTick();
void uiShowSessionPicker(int sel);     // fake-CLI; sel 0 = "+ new session"

// Conversation screen (fake-CLI). sendMarked/sentBusy drive the queue /
// sent / thinking footer state after a voice.confirm. errorText (if
// non-null) is a recent voice-pipeline error shown in the footer.
void uiShowConvo(bool sendMarked, bool sentBusy, const char* errorText);
// Conversation tick: transcribing dots animation only (partial redraw).
void uiTickConvo();

// Full-screen recording view, shared by conversation and mic mode:
// red dot + REC timer + big RMS bar with volume gradient (green->red).
void uiShowRecording(int levelPct, uint32_t elapsedMs);
void uiTickRecording(int levelPct, uint32_t elapsedMs);

// Device-local voice-input microphone screen (fake-CLI idle view).
void uiShowMic(const char* errorText, bool yolo = false);

// Partial redraw of the conversation content area (tail message view).
void uiRedrawConvoTail();

// Page the conversation content by whole tail messages; delta < 0 = older,
// > 0 = newer. Partial redraw; no-op at the ends or with no tail.
void uiConvoPage(int delta);
// Reset the reading position to the newest message (call on screen entry
// and after sending).
void uiConvoPageReset();
// Sync after a tail content update: live-follow only if the user is at the
// newest page; a user paging through history keeps their page.
void uiConvoTailSync();
