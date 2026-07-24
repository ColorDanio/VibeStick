#include "mic.h"

#include "board.h"

#ifndef VIBESTICK_BOARD_S3
#include <driver/i2s.h>
#endif

// Mic hardware: StickC Plus has a PDM SPM1423 on I2S0 (CLK=GPIO0,
// DATA=GPIO34); StickS3 has a MEMS mic behind the ES8311 codec, captured
// through M5Unified's Mic_Class.
#define MIC_I2S_PORT I2S_NUM_0
#define MIC_PIN_CLK 0
#define MIC_PIN_DATA 34
#define MIC_SAMPLE_RATE 8000

#define RING_SIZE 8192
#define READ_SAMPLES 256  // 32 ms per i2s_read at 8 kHz

static uint8_t sRing[RING_SIZE];
static volatile size_t sHead = 0;  // write pos (mic task)
static volatile size_t sTail = 0;  // read pos (loop)

static TaskHandle_t sTask = nullptr;
static bool sDriverInstalled = false;
static volatile int sLevel = 0;
static uint32_t sPeak = 2500;  // running peak for AGC (decays ~50% / 2.2 s)
static volatile bool sStopReq = false;  // cooperative task shutdown

void micInit() {
  if (sDriverInstalled) return;
#ifdef VIBESTICK_BOARD_S3
  if (M5.Mic.begin()) {
    sDriverInstalled = true;
    Serial.println("[MIC] ES8311 via M5Unified (8 kHz mono)");
  } else {
    Serial.println("[MIC] M5.Mic.begin failed");
  }
  return;
#endif

  i2s_config_t cfg = {};
  cfg.mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX | I2S_MODE_PDM);
  cfg.sample_rate = MIC_SAMPLE_RATE;
  cfg.bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT;
  cfg.channel_format = I2S_CHANNEL_FMT_ONLY_RIGHT;
  cfg.communication_format = I2S_COMM_FORMAT_STAND_I2S;
  cfg.intr_alloc_flags = ESP_INTR_FLAG_LEVEL1;
  cfg.dma_buf_count = 4;
  cfg.dma_buf_len = READ_SAMPLES;
  cfg.use_apll = false;
  cfg.tx_desc_auto_clear = false;
  cfg.fixed_mclk = 0;

  if (i2s_driver_install(MIC_I2S_PORT, &cfg, 0, nullptr) != ESP_OK) {
    Serial.println("[MIC] i2s_driver_install failed");
    return;
  }

  i2s_pin_config_t pins = {};
  pins.bck_io_num = I2S_PIN_NO_CHANGE;
  pins.ws_io_num = MIC_PIN_CLK;
  pins.data_out_num = I2S_PIN_NO_CHANGE;
  pins.data_in_num = MIC_PIN_DATA;
  i2s_set_pin(MIC_I2S_PORT, &pins);
  i2s_set_clk(MIC_I2S_PORT, MIC_SAMPLE_RATE, I2S_BITS_PER_SAMPLE_16BIT,
              I2S_CHANNEL_MONO);

  sDriverInstalled = true;
  Serial.println("[MIC] I2S0 PDM installed (8 kHz mono)");
}

static void ringWrite(const uint8_t* data, size_t len) {
  for (size_t i = 0; i < len; ++i) {
    size_t next = (sHead + 1) % RING_SIZE;
    if (next == sTail) return;  // full: drop (consumer too slow)
    sRing[sHead] = data[i];
    sHead = next;
  }
}

size_t micRead(uint8_t* dst, size_t maxLen) {
  size_t n = 0;
  while (n < maxLen && sTail != sHead) {
    dst[n++] = sRing[sTail];
    sTail = (sTail + 1) % RING_SIZE;
  }
  return n;
}

int micLevel() { return sLevel; }

bool micRunning() { return sTask != nullptr; }

static void micTask(void* arg) {
  int16_t raw[READ_SAMPLES];
  uint8_t out[READ_SAMPLES];
  size_t bytesRead = 0;
  uint32_t smooth = 0;

  Serial.println("[MIC] capture task started (core 0)");
  while (!sStopReq) {
#ifdef VIBESTICK_BOARD_S3
    if (!M5.Mic.record(raw, READ_SAMPLES, MIC_SAMPLE_RATE)) {
      vTaskDelay(pdMS_TO_TICKS(10));
      continue;
    }
    bytesRead = sizeof(raw);
#else
    if (i2s_read(MIC_I2S_PORT, raw, sizeof(raw), &bytesRead,
                 pdMS_TO_TICKS(100)) != ESP_OK || bytesRead == 0) {
      continue;
    }
#endif
    size_t n = bytesRead / sizeof(int16_t);
    uint32_t acc = 0;
    for (size_t i = 0; i < n; ++i) {
      int16_t s = raw[i];
      acc += (uint32_t)abs(s);
      int v = (s >> 8) + 128;  // 16-bit signed -> 8-bit unsigned
      out[i] = (uint8_t)(v < 0 ? 0 : (v > 255 ? 255 : v));
    }
    if (n > 0) {
      // RMS-ish level: mean |sample|, smoothed, then auto-gained against a
      // running peak (last ~1-2 s) with a floor, so normal speech volume
      // drives the bar to the middle instead of needing shouting.
      uint32_t mean = acc / n;  // full-scale 32768
      smooth = (smooth * 7 + mean) / 8;
      sPeak = smooth > sPeak ? smooth : (sPeak * 995) / 1000;
      uint32_t ref = sPeak > 2500 ? sPeak : 2500;  // floor: no silence boost
      int lvl = (int)((smooth * 70) / ref);
      sLevel = lvl > 100 ? 100 : lvl;
    }
    ringWrite(out, n);
  }
  Serial.println("[MIC] capture task exiting");
  sTask = nullptr;
  vTaskDelete(nullptr);
}

void micStart() {
  micInit();
  if (!sDriverInstalled || sTask != nullptr) return;
  sHead = sTail = 0;
  sLevel = 0;
  sPeak = 2500;
  sStopReq = false;
#ifndef VIBESTICK_BOARD_S3
  i2s_zero_dma_buffer(MIC_I2S_PORT);
  i2s_start(MIC_I2S_PORT);
#endif
  xTaskCreatePinnedToCore(micTask, "mic", 4096, nullptr,
                          1,  // low priority: BLE must keep its CPU budget
                          &sTask, 0);
}

void micStop() {
  if (sTask != nullptr) {
    // Cooperative shutdown: the task exits i2s_read (100 ms timeout) and
    // deletes itself; no mid-driver vTaskDelete from another context.
    sStopReq = true;
    uint32_t deadline = millis() + 400;
    while (sTask != nullptr && millis() < deadline) vTaskDelay(1);
    if (sTask != nullptr) {  // fallback, should not happen
      vTaskDelete(sTask);
      sTask = nullptr;
    }
  }
#ifndef VIBESTICK_BOARD_S3
  if (sDriverInstalled) i2s_stop(MIC_I2S_PORT);
#endif
  sLevel = 0;
  Serial.println("[MIC] capture stopped");
}
