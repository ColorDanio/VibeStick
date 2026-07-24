# VibeStick — a vibe-coding key on M5StickC Plus

A pocket companion for AI coding CLIs (Claude Code, Codex, opencode,
Kimi CLI, …). VibeStick shows live session status on the StickC Plus
display over Bluetooth, lets you switch tools and sessions, trigger
tool key bindings, and talk to your CLI with the built-in microphone —
speech is transcribed on the host and sent as text.

Hardware: [M5StickC Plus](https://docs.m5stack.com/en/core/m5stickc_plus)
(ESP32-PICO, 240x135 LCD, 2 buttons, mic, IMU, IR, PMU).

## How it works

```
┌──────────────┐   BLE GATT    ┌────────────────────────────┐
│ M5StickC Plus│ ◄──────────► │ vibestickd (host daemon)    │
│  firmware/   │  "VibeStick" │  host/                      │
│  mic ────────┼── audio ────►│   ASR (faster-whisper/cmd)  │
└──────────────┘              │   ~/.vibestick/config.json  │
                              │   setup UI :7860            │
                              └───────▲─────────────────────┘
                                      │ state files
                    ┌─────────────────┴──────────────────┐
                    │ claude-code statusLine adapter      │
                    │ generic wrapper (codex, kimi, …)    │
                    └────────────────────────────────────┘
```

## Features

- **Status at a glance** — tool, model, session state (color-coded),
  context-window %, cost, and last assistant action, plus BLE and
  battery in a status bar.
- **Tool carousel** — switch between configured CLI tools; per-tool
  function list driven by host config.
- **Key bindings** — trigger tool functions (Enter, Escape, Ctrl-C,
  or any custom binding, e.g. Codex shortcuts) from the stick.
- **Voice input** — record on the stick, audio streams over BLE, host
  ASR (faster-whisper or your own command) transcribes, review the
  transcript on screen, double-click to send it into the CLI.
- **Sessions** — browse and switch sessions of the selected tool.
- **Extras** — shake-to-refresh (IMU), BLE status LED, auto-dim,
  battery gauge.
- **Setup UI** — local web app (`vibestickd --setup`, port 7860) to
  configure tools, key bindings, and the ASR engine.

## Controls

| Context    | Button A              | Button B            | Power button            |
|------------|-----------------------|---------------------|-------------------------|
| Tool picker| select tool           | next tool           | (no-op)                 |
| Tool view  | activate function     | next function       | back                    |
| Sessions   | open session detail   | next session        | back                    |
| Session detail | long-press: voice | next session        | back                    |
| Voice      | start/stop recording  | cancel              | back (cancels)          |
| Voice ready| **double-click: send**| cancel              | back (cancels)          |
| Anywhere   | long-press: refresh   | long-press: back    | short: back, **2×: home** |

Shake the stick to force a status refresh. The UI auto-rotates between
portrait and landscape (all four orientations) based on how you hold
the stick — it stays put while lying flat on a desk.

## Layout

- `docs/protocol.md` — BLE GATT protocol v2 (single source of truth).
- `firmware/` — PlatformIO project for the StickC Plus.
- `host/` — Python daemon (`vibestickd`), setup UI, CLI adapters, tests.

## Quick start

1. Host: `pip install -e "host/[dev]"`, run `vibestickd --setup` once
   to configure tools and ASR, then `vibestickd` (see `host/README.md`).
2. Firmware: `firmware/.venv/bin/pio run -d firmware -t upload`
   (device on `/dev/ttyUSB0`).
3. Register the Claude Code statusLine adapter; for other CLIs use
   `source host/adapters/generic_wrapper.sh` + `vibe_wrap <cmd>`.
