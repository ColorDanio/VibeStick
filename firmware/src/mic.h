#pragma once

#include <Arduino.h>

// SPM1423 mic capture: 8 kHz 16-bit PDM on I2S0, converted to 8-bit
// unsigned PCM and pushed into a ring buffer. A FreeRTOS task on core 0
// produces; the app (loop, core 1) consumes via micRead() and notifies
// the AUDIO characteristic.

// Install the I2S driver once (idempotent).
void micInit();

// Start/stop the capture task. Stopping drains nothing; buffered data
// older than the stop is discarded on the next micStart().
void micStart();
void micStop();
bool micRunning();

// Copy up to maxLen bytes of captured PCM out of the ring buffer.
size_t micRead(uint8_t* dst, size_t maxLen);

// Smoothed mic level 0..100 (RMS-based), for the recording indicator.
int micLevel();
