# VibeStick — a vibe-coding key on M5StickC Plus

A pocket companion for AI coding CLIs (Claude Code, Codex, opencode,
Kimi CLI, …). VibeStick shows live session status on the StickC Plus
display over Bluetooth, lets you browse sessions and read the
conversation tail, cancel inference, and talk to your CLI with the
built-in microphone — speech is transcribed on the host and injected
into the session as text. It can also act as a plain Bluetooth
microphone for your desktop apps (openwhispr, ChatGPT app, …).

Hardware: [M5StickC Plus](https://docs.m5stack.com/en/core/m5stickc_plus)
(ESP32-PICO, 240x135 LCD, 2 buttons + power button, mic, IMU, IR, PMU).

## Architecture

```
                 ┌────────────────────────── host ───────────────────────────┐
                 │                                                           │
┌──────────────┐ │  ┌─────────────┐   ┌──────────────┐   ┌────────────────┐  │
│ M5StickC Plus│ │  │ adapters    │   │ discovery    │   │ dashboard      │  │
│              │ │  │ statusline/ │   │ on-disk CLI  │   │ Overview       │  │
│  firmware/   │ │  │ hook/wrapper│   │ session scan │   │ Agents         │  │
│  mic ──audio──┼─┼►│  state files│   │ /proc watch  │   │ Voice & Mic    │  │
│  LCD ◄─status─┼─┼┤└──────┬──────┘   └──────┬───────┘   │ Settings       │  │
│  buttons ─cmd─┼─┼►│       └────────┬─────────┘          └──────▲─────────┘  │
└──────────────┘ │                  ▼                          │ HTTP :7860  │
      BLE GATT   │           ┌─────────────┐    ┌────────────────┴───┐        │
    "VibeStick"  │           │ store       ├───►│ vibestickd daemon  │        │
                 │           │ (sessions,  │    │ bridge/queue/ASR   │        │
                 │           │  selection) │    └───────┬────────────┘        │
                 │           └─────────────┘            │                     │
                 │                    ┌─────────────────┼─────────────────┐   │
                 │                    ▼                 ▼                 ▼   │
                 │          tmux / zellij      TIOCSTI tty inject   virtual │
                 │          (multiplexers)      (plain terminals)   mic source│
                 └───────────────────────────────────────────────────────────┘
```

- **firmware/** — PlatformIO project for the StickC Plus. BLE GATT
  client UI: tool carousel, session picker, conversation reader,
  voice recorder with RMS meter, virtual-mic mode. See `docs/protocol.md`
  for the wire protocol (single source of truth).
- **host/** — Python daemon (`vibestickd`). Collects session state from
  three sources (adapter files > on-disk discovery > /proc presence),
  owns tool/session selection, queues and delivers messages
  (tmux `send-keys`, zellij actions, or TIOCSTI tty injection),
  transcribes voice
  (faster-whisper or an external command), feeds the virtual microphone,
  and serves the dashboard at `http://127.0.0.1:7860`.
- **docs/** — protocol spec and architecture notes.
- **host/adapters/** — Claude Code statusLine adapter, Kimi Code hooks
  adapter, generic wrapper for other CLIs.

A deeper dive lives in [docs/architecture.md](docs/architecture.md).

## Features

- **Live status** — per-tool session state (idle / thinking / waiting),
  conversation tail, foreground dots; BLE + battery in the status bar.
- **Session browser** — per-tool session list with a "new session"
  entry; open one to read its message history (paged, newest-first).
- **Voice input** — long-press to record on the stick, host ASR
  transcribes (simplified-Chinese/English biased), single-click to send.
  Busy session? Messages queue host-side (FIFO ×8) and flush when the
  session goes idle — the stick shows a queue indicator.
- **Inference cancel** — single-click A while a session is thinking
  sends the tool's cancel key (Escape by default).
- **Microphone mode** — the stick registers as a system input device
  ("Vibe Mic", PipeWire virtual source); press A to talk into any
  desktop app that binds a microphone.
- **Dashboard** — local web app: Overview cards, master-detail Agents
  monitor, modern Settings center, Voice & Mic diagnostics with recent
  transcriptions. Also available as a desktop app (`vibestick-app`).
- **Adaptive UI** — portrait/landscape auto-rotation from the IMU,
  double-shake to refresh, auto-dim, battery gauge.

## Controls

| Screen      | Button A                                  | Button B        | Power button          |
|-------------|-------------------------------------------|-----------------|-----------------------|
| Home        | select tool / enter Microphone            | next tool       | —                     |
| Sessions    | open session (entry 0 = new session)      | next session    | back                  |
| Conversation| older message · thinking: **cancel** · transcript ready: **send** | newer message | back |
| Recording   | **hold to record**, release to transcribe | discard draft   | back (cancels)        |
| Transcript  | 2×A: discard · A: send                    | discard         | back                  |
| Microphone  | **PTT + F19** (press/release)             | **F20**          | back                  |
| Anywhere    | —                                         | long-press: back| short: back · **2×: home** |

Double-shake the stick to force a status refresh.

## Quick start

1. Host: `pip install -e "host/[dev,asr]"`, then `vibestick-web`
   (daemon + dashboard at http://127.0.0.1:7860). See `host/README.md`.
2. Firmware: `firmware/.venv/bin/pio run -d firmware -t upload`
   (device on `/dev/ttyUSB0`).
3. Optional: register the adapters — Claude Code statusLine and Kimi
   hooks give the richest state; other CLIs work via on-disk discovery
   and process presence with no setup.
4. Optional desktop integration: `vibestick-app --install-desktop`
   (GNOME launcher entry + daemon autostart).

> tty delivery (voice messages and cancel into CLIs running in plain
> terminals) uses the TIOCSTI ioctl. Recent kernels (~6.15+) restrict
> TIOCSTI to the caller's controlling terminal, which a background
> daemon can never satisfy — on such systems tty delivery is
> unavailable and the dashboard shows a warning. The reliable path is
> to run your CLI inside tmux (`tmux new -s vibe`, then start the CLI);
> delivery then uses `tmux send-keys` and works everywhere.

## Development

```sh
host/.venv/bin/python -m pytest host/tests/   # host test suite
firmware/.venv/bin/pio run -d firmware        # firmware build
```

CI builds both on every push (`.github/workflows/ci.yml`).

## Layout

- `docs/protocol.md` — BLE GATT protocol v2 (single source of truth).
- `docs/architecture.md` — component and data-flow deep dive.
- `firmware/` — PlatformIO project for the StickC Plus.
- `host/` — Python daemon, dashboard, desktop app, CLI adapters, tests.
