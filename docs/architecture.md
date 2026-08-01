# VibeStick architecture

This document describes how the pieces fit together. The BLE wire
format itself is specified in [protocol.md](protocol.md); this file
covers everything around it.

## Components

| Component        | Location                | Role |
|------------------|-------------------------|------|
| Firmware         | `firmware/src/`         | BLE client, UI state machine, mic capture, IMU/power handling |
| Daemon           | `host/vibestick/daemon.py` | Owns all host-side state; wires everything together |
| BLE bridge       | `host/vibestick/bridge.py` | bleak client: scan/connect, characteristic sync, reconnect backoff |
| Session store    | `host/vibestick/store.py`  | Merges adapter files, discovery, presence; selection; state rules |
| Discovery        | `host/vibestick/discover.py` | Reads each CLI's on-disk session store |
| Presence watcher | `host/vibestick/procwatch.py` | `/proc` scan for live CLI processes |
| Delivery         | `host/vibestick/delivery.py` | tmux send-keys / zellij actions / TIOCSTI tty injection |
| Voice pipeline   | `host/vibestick/voice.py`  | PCM buffering, preprocessing, ASR, transcription log, clips |
| Virtual mic      | `host/vibestick/mic.py`    | PipeWire virtual source fed from device audio |
| Dashboard        | `host/vibestick/setupui.py` + `assets/` | stdlib HTTP server + vanilla JS SPA |
| Desktop app      | `host/vibestick/app.py`    | pywebview or `chrome --app=` wrapper, GNOME integration |
| Adapters         | `host/adapters/`           | Claude statusLine, Kimi hooks, generic shell wrapper |

## Data flows

### Status (host → stick)

1. Sources produce session records:
   - **Adapter files** — CLIs launched with an adapter write JSON state
     files into `~/.vibestick/sessions/` (richest data: model, context
     %, cost, delivery target).
   - **Discovery** — every ~10 s the daemon parses each tool's own
     on-disk store (`~/.claude/projects`, `~/.codex/sessions`,
     `~/.kimi-code/sessions`, opencode's sqlite) and synthesizes
     `disc:*` records with a sanitized conversation tail.
   - **Presence** — every ~5 s `/proc/*/cmdline` is scanned; a live CLI
     process with no other records yields one `proc:<pid>` session.
   - Precedence per tool: **adapter > discovered > presence** (no
     duplicates).
2. `store` computes each session's state. A discovered session is
   `running` only while its transcript mtime is within
   `DISCOVERED_RECENT_SEC` (20 s) *and* the tool process is alive —
   transcripts stream during generation, so a fresh mtime means
   inference; the window prevents "stuck thinking" after it ends.
   `fg` (open in a terminal) uses the wider 3-minute window.
3. On any change, the bridge pushes TOOLS / SESSIONS / STATUS / VOICE
   payloads to the stick. The firmware renders them in the current
   screen; unknown JSON keys are ignored (forward compatibility).

### Input (stick → host)

- `tool.next` / `tool.select` / `session.select` — selection moves;
  the daemon re-pushes the affected payloads.
- `session.new` — opens a new tmux window anchored at the tool's pane
  running its launch command; the new session is auto-selected once it
  surfaces.
- `inference.cancel` — sends the tool's cancel binding (default
  Escape) to the active session's delivery target.
- Typed INPUT messages and `voice.confirm` transcripts go through the
  **send queue**: if the target session is `running`, the message is
  queued (per-session FIFO, cap 8, oldest dropped) and flushed in
  order ~300 ms apart once the session leaves `running`. STATUS carries
  `queued: N` while pending. Delivery failures are reported once via a
  STATUS `error`, never retried in a loop.

### Voice (stick → host → stick)

1. Long-press A: firmware captures mic audio and streams 8 kHz 8-bit
   unsigned PCM frames over the AUDIO characteristic (`voice.start` /
   frames / `voice.stop`).
2. The daemon preprocesses: u8 → float32, DC removal, DC-blocker
   high-pass, polyphase resample 8→16 kHz (scipy, linear fallback),
   p99 peak normalization (target 0.7, gain cap 30).
3. faster-whisper transcribes with Silero VAD (relaxed threshold 0.3),
   hardened decode parameters (no condition-on-previous-text,
   no-speech/log-prob/compression-ratio thresholds, beam 5) and an
   initial prompt biasing simplified Chinese + English. `language`
   stays auto-detect. A `command` engine can run any external ASR
   instead.
4. The transcript is pushed (VOICE `ready`) for on-device review:
   A sends, 2×A discards, long-press re-records.
5. Every attempt is logged to `~/.vibestick/voice-log.jsonl`
   (ring of 20; duration, processing time, model, detected language,
   clip file, ok/no-speech/error + reason) and the raw audio is kept
   in `~/.vibestick/clips/clip-1..5.wav` (rotating).
   `host/tools/asr_debug.py <wav>` replays a clip across models for
   offline comparison.

### Microphone mode (stick → desktop apps)

With `voice.start {"mode": "mic"}` the daemon routes audio to a
PipeWire virtual source named **Vibe Mic** (a persistent
`support.null-audio-sink` adapter node with the `device.*` properties
GNOME Settings needs, fed per-press by `pw-cat` with ×3 software gain).
The stick behaves like any USB microphone: bind it in openwhispr, the
ChatGPT app, or anywhere else; A press starts PTT immediately and A release
stops it. In this mode A and B also emit their configured HID shortcuts
(defaults: F14 and F15; Ctrl/Alt/Shift + F1–F24 are supported).

## Delivery targets

Each session record may carry a `tmux` pane id, a `zellij` session
name (plus optional `zellij_pane`), or a `tty` path (discovered/presence
sessions inherit the CLI process's controlling terminal, resolved from
`/proc/<pid>/stat`). Per-tool `delivery` config
(`auto`/`tmux`/`zellij`/`tty`) picks the transport; auto order is
tmux -> zellij -> tty:

- **tmux** — `tmux send-keys -t <pane> -- <text> Enter`. Always works.
- **zellij** — `zellij --session <s> action write-chars <text>` followed
  by `action write 13` (Enter); key bindings go out as `action write
  <bytes>` (ctrl bytes and ANSI escape sequences for arrows/F-keys).
  `session.new` uses `action new-pane -- <cli>`. Works everywhere tmux
  does — either multiplexer is a first-class target.
- **tty** — bytes are injected into the terminal's input queue with the
  **TIOCSTI** ioctl (one ioctl per byte, control bytes included).
  Writing to the pts slave would only *display* text, not deliver it.
  A safety gate requires the process alive, still attached to that
  terminal, in its foreground process group, and the pts writable.
  Kernels ~6.15+ restrict TIOCSTI to the caller's controlling terminal,
  which a background daemon cannot satisfy — the daemon probes
  injection at startup (`/api/status` → `tiocsti`) and the dashboard
  recommends tmux or zellij when the probe fails — run your CLI in
  either multiplexer and delivery works everywhere (tmux delivery is
  unaffected).

All delivery is best-effort with timeouts; failures are logged, never
fatal.

## Firmware UI state machine

Screens (`firmware/src/main.cpp`): `WAITING` (BLE connect / boot) →
`HOME` (tool carousel + device-local Microphone entry) → `SESSIONS`
(per-tool list, entry 0 = new session) → `CONVO` (message reader +
voice states). `MIC` is the microphone mode.

Notable details:

- **Optimistic navigation** — carousel moves instantly on the button
  press and reconciles with host sync afterwards (`NAV_SYNC_MS`),
  keeping the UI snappy over BLE latency.
- **Message paging** — `CONVO` shows one message at a time; A/B page
  older/newer, 2×A jumps to the newest. The transcript overlay shares
  the screen: A sends, 2×A discards, long-press re-records.
- **Recording** — hold-to-record (≥500 ms press) on `CONVO`/`MIC`;
  release stops. A full-screen RMS meter with a green→yellow→red
  gradient renders live levels; orientation-aware (vertical bar in
  portrait, horizontal in landscape).
- **IMU** — orientation auto-rotation (all four), double-shake refresh,
  motion wake; stable while lying flat.
- **Power button** — StickS3 short press returns from a submenu and restarts
  only on home; its PMU 2-second hold still enters download mode. C Plus uses
  the legacy short-back/double-home behavior.
- **Rendering safety** — all LCD text passes through a sanitizer that
  replaces non-ASCII bytes with `?` (the built-in GLCD font has no CJK
  glyphs and its renderer wedges the ESP32 on high bytes); every
  truncation index is clamped to its buffer.

## Configuration

`~/.vibestick/config.json` (created with defaults on first run):
`tools[]` (id, name, adapter, delivery, process, command, bindings,
show/discover flags), `asr` (engine, model, device, language, command),
`mic` (virtual mic enabled), `features` (process watcher etc.).
The dashboard edits it atomically; the daemon watches the mtime and
reloads live. See `host/README.md` for the full schema and adapter
setup instructions.
