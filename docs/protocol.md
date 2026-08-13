# VibeStick BLE Protocol (v2)

Communication between the host daemon (computer) and a supported VibeStick
(M5StickC Plus or M5StickS3) uses a single custom GATT service.

- The **device** (M5StickC Plus or M5StickS3) is the GATT **server** (BLE peripheral).
  It advertises the name `VibeStick`.
- The **daemon** (computer) is the GATT **client** (BLE central).
- The daemon holds all session/tool state; the device is a display +
  input terminal with a microphone.

## Service

- Service UUID: `4b1e0001-5a3f-4c8d-9b6e-7f2a1c0d3e5f`

## Characteristics

| Name     | UUID                                   | Properties | Writer | Reader | Payload |
|----------|----------------------------------------|------------|--------|--------|---------|
| STATUS   | `4b1e0002-5a3f-4c8d-9b6e-7f2a1c0d3e5f` | write      | daemon | device | JSON    |
| SESSIONS | `4b1e0003-5a3f-4c8d-9b6e-7f2a1c0d3e5f` | write      | daemon | device | JSON    |
| INPUT    | `4b1e0004-5a3f-4c8d-9b6e-7f2a1c0d3e5f` | notify     | device | daemon | JSON    |
| COMMAND  | `4b1e0005-5a3f-4c8d-9b6e-7f2a1c0d3e5f` | notify     | device | daemon | JSON    |
| TOOLS    | `4b1e0006-5a3f-4c8d-9b6e-7f2a1c0d3e5f` | write      | daemon | device | JSON    |
| VOICE    | `4b1e0007-5a3f-4c8d-9b6e-7f2a1c0d3e5f` | write      | daemon | device | JSON    |
| AUDIO    | `4b1e0008-5a3f-4c8d-9b6e-7f2a1c0d3e5f` | notify     | device | daemon | binary  |
| DEVICE_CONFIG | `4b1e0009-5a3f-4c8d-9b6e-7f2a1c0d3e5f` | write | daemon | device | JSON |
| USAGE    | `4b1e000a-5a3f-4c8d-9b6e-7f2a1c0d3e5f` | write | daemon | device | JSON |

JSON payloads are UTF-8, one complete document per write/notify, kept
under 512 bytes by trimming optional fields. Negotiated MTU is 247, so
payloads over 244 bytes (TOOLS/SESSIONS with several entries) are sent
with the ATT long-write procedure — hosts MUST write with response
(write request), not write-without-response, which BlueZ rejects for
oversized values.

## Interaction model (device UX, v2.1)

Session-centric flow over a terminal-style ("fake CLI") screen:

- **Tool picker (home)**: `B` = next tool, `A` = select tool.
- When a host provides at least one local usage metric, an additional
  read-only **Usage** entry appears after the device-local Vibe Mic and YOLO
  entries. It is omitted when the host has no usable metrics.
- **Session picker** (fake-CLI screen for the selected tool): lists
  `+ new session` first, then known sessions with an **active dot**
  (green = session is live in the foreground, see `fg` below; gray =
  inactive). `B` = next entry, `A` = enter session.
- **Conversation screen** (same fake-CLI look, one screen only):
  header shows tool + session, body shows status (`state`, `ctx_pct`,
  `last` summary), footer is the status line.
  - **Hold `A`** (>=500 ms) = start recording (`voice.start`); the RMS
    level bar is shown **only while held** — vertical in portrait,
    horizontal in landscape. **Release `A`** = stop (`voice.stop`);
    the host transcribes and pushes the transcript via VOICE.
  - **Double-click `A`** with a `ready` transcript = `voice.confirm`
    (send). After sending, the device shows `thinking` when the next
    STATUS reports `state: "running"`; if the session was already
    `running` at send time it shows `queue` until the state changes.
  - **Double-click `A`** while `thinking`/`running` = cancel the
    ongoing inference (`inference.cancel`).
  - `B` with a pending transcript = discard (`voice.cancel`).
- **Power key**: on the StickS3, a short press returns from a submenu and
  restarts the device only on the home screen; the PMU still enters download
  mode after a 2-second hold. The C Plus keeps its legacy short-back and
  double-home behavior.
- Long-press `B` (>=800 ms, anywhere) = back. Shake = `refresh`.

`fn.activate` remains in the protocol for backwards compatibility but
the v2.1 device UI no longer emits it; custom key bindings are managed
host-side only.

### Device UI mirror (`COMMAND`, device -> daemon)

Current firmware emits a compact `device.ui` notification whenever a screen,
carousel selection, or recording state changes. It is the source of truth for
the desktop's read-only Stick simulator: the host reconstructs the same screen
from the existing STATUS, SESSIONS, TOOLS, VOICE, and USAGE payloads instead of
streaming framebuffer pixels over BLE.

```json
{"cmd":"device.ui","screen":"sessions","selected":2,"recording":false,"battery":73,"rotation":1}
```

`screen` is `waiting`, `home`, `sessions`, `convo`, `mic`, `yolo`, or `usage`.
`selected` is the highlighted home/session entry and is `-1` elsewhere. Older
firmware lacks this notification; the desktop falls back to a host-state view.
`battery` is `0`–`100` when the PMU reports a level (otherwise `-1`), and
`rotation` is the active LCD rotation (`0`–`3`).

## Payloads

### TOOLS (daemon -> device)

The configured vibe-coding CLI tools and their functions.

```json
{
  "active": 0,
  "list": [
    {
      "id": "claude-code",
      "name": "Claude Code",
      "state": "running",
      "fns": ["status", "sessions", "voice", "enter", "escape"]
    },
    {
      "id": "codex",
      "name": "Codex",
      "state": "idle",
      "fns": ["status", "voice", "ctrl-c"]
    }
  ]
}
```

### USAGE (daemon -> device)

Optional local usage summaries are sampled by the host every 30 seconds. A
CLI is included only when its adapter supplied at least one usable context,
quota, token, or cost metric; wrappers that only expose process state are
omitted. The payload
is independent from STATUS so older firmware can continue to connect when it
does not expose this optional characteristic.

```json
{
  "updated": 1721650000,
  "interval_s": 30,
  "list": [
    {"tool":"claude-code","name":"Claude Code","sessions":2,"active":1,"ctx_pct":42,"cost_usd":1.23,"updated":1721650000},
    {"tool":"codex","name":"Codex","sessions":1,"active":1,"quota_pct":12,"tokens":120000,"updated":1721650000}
  ]
}
```

`ctx_pct`, `quota_pct`, `tokens`, and `cost_usd` are independently optional;
the host never invents a zero for a missing metric.

- `state`: aggregate of that tool's sessions (`running` if any session
  is running, else `waiting` / `error` / `idle`).
- `fns`: ordered function ids shown in tool view. Well-known ids:
  `status`, `sessions`, `voice`, `enter`, `escape`. Any other id is a
  **custom key binding** configured on the host (delivered to the tool
  as keystrokes, e.g. `ctrl-x`, `shift-tab`, or a literal string).

### STATUS (daemon -> device)

Status of the selected tool's active session:

```json
{
  "tool": "claude-code",
  "model": "claude-opus-4",
  "session": "fix-auth-bug",
  "state": "running",
  "ctx_pct": 42,
  "cost_usd": 1.23,
  "last": "Edited src/auth.ts",
  "tail": [
    "user: fix the auth redirect",
    "assistant: Edited src/auth.ts",
    "assistant: Running tests..."
  ],
  "queued": 2,
  "updated": 1721650000
}
```

- `tail` (v2.2): recent conversation lines, oldest first, each prefixed
  `user: ` / `assistant: `; omitted when empty.
- `queued` (v2.2): number of host-side messages waiting in the send
  queue for this session (the daemon queues messages sent while the
  session is busy and flushes them FIFO when it goes idle); omitted
  when 0. The firmware already renders a `queue` footer from
  `state == "running"` — no firmware change required.

- `tail` (v2.2): the most recent few conversation/status lines of the
  selected session, oldest first, each pre-trimmed by the daemon
  (~60 chars). The device renders them as the conversation body
  (terminal style); `last` remains as fallback when `tail` is absent.
  When the payload would exceed 512 bytes, `tail` entries are dropped
  first (oldest to newest), then other optional fields.

### SESSIONS (daemon -> device)

Sessions of the **selected tool** (unchanged from v1):

```json
{
  "active": 0,
  "list": [
    {"id": "a1b2", "tool": "claude-code", "name": "fix-auth-bug", "state": "running", "fg": true}
  ]
}
```

- `fg` (v2.1): `true` when the session is live in the foreground —
  adapter-reported when available, else heuristic (session file mtime
  < 3 min and the tool's process is alive). The device renders this as
  the active dot in the session picker.

### VOICE (daemon -> device)

Voice pipeline state for the device screen:

```json
{"state": "recording", "text": ""}
{"state": "transcribing", "text": ""}
{"state": "ready", "text": "looks good, continue"}
{"state": "error", "text": "no speech detected"}
{"state": "idle", "text": ""}
```

### AUDIO (device -> daemon, binary)

Raw PCM: **8 kHz, 8-bit unsigned, mono**. Each notify carries up to
180 bytes of samples. Streaming starts after the daemon receives
`voice.start` and stops after `voice.stop`. Frames arriving outside a
recording window are ignored.

`voice.start` without `mode` is the ASR flow (transcribe on stop).
With `"mode": "mic"` (v2.1) the daemon routes the PCM into a virtual
microphone on the host (a PipeWire `Audio/Source` named "VibeStick
Mic") instead of transcribing — select it as the input device in any
application. Mic-mode frames never reach the ASR pipeline and vice
versa.

### INPUT (device -> daemon)

```json
{"type": "message", "text": "looks good, continue", "source": "voice"}
{"type": "message", "text": "typed text", "source": "keyboard"}
```

`source` is informational; the daemon delivers `text` to the selected
tool's active session (tmux `send-keys`, tty write, or configured
delivery), then resumes STATUS pushes (back to monitoring).

### COMMAND (device -> daemon)

```json
{"cmd": "tool.next"}
{"cmd": "tool.select", "id": "codex"}
{"cmd": "fn.activate", "fn": "escape"}
{"cmd": "session.next"}
{"cmd": "session.prev"}
{"cmd": "session.select", "id": "c3d4"}
{"cmd": "voice.start"}
{"cmd": "voice.start", "mode": "mic"}
{"cmd": "voice.stop"}
{"cmd": "voice.confirm"}
{"cmd": "voice.cancel"}
{"cmd": "inference.cancel"}
{"cmd": "session.new"}
{"cmd": "refresh"}
```

When the host subscribes to `COMMAND`, firmware 0.2.1 also publishes its
identity. This lets VibeConn choose the matching product artwork without
guessing from the BLE name:

```json
{"cmd":"device.info","model":"M5StickC-Plus","firmware":"0.2.1"}
```

`model` is `M5StickC-Plus` or `M5StickS3`. Hosts that do not understand this
optional event must ignore it.

### DEVICE_CONFIG (daemon -> device)

Firmware 0.2.1 accepts Vibe Mic HID shortcuts. Each shortcut is `F1` through
`F24`, optionally prefixed by `Ctrl`, `Alt`, and/or `Shift` (for example
`Ctrl+F2` or `Ctrl+Alt+F8`). Invalid or missing values leave the existing
binding unchanged. Defaults are Button A = `F14` and Button B = `F15`.

```json
{"hid":{"button_a":"Ctrl+F2","button_b":"Alt+F14"}}
```

- `fn.activate` with a custom binding id makes the host send that key
  binding to the tool's active session.
- `voice.confirm` makes the host deliver the `ready` transcript via the
  normal message delivery path; `voice.cancel` discards it.
- `inference.cancel` (v2.1) cancels the ongoing inference of the
  selected session, best-effort: the daemon sends the configured
  `cancel` key binding (default `Escape`) to the session's delivery
  target (tmux `send-keys` or tty write).
- `session.new` asks the daemon to start a fresh session of the selected tool
  using the configured session launcher. It supplies the tool's `command`
  and optional `cwd`; `auto` reuses a tmux/zellij target and otherwise creates
  a standalone wrapped tmux session. Forced zellij requires an existing
  zellij target.
- Messages sent to a busy (`running`) session are still delivered —
  terminal input buffers naturally — so they act as a queue.

## Host-side configuration

The daemon reads `~/.vibestick/config.json` (editable via the setup
UI, see `host/README.md`):

```json
{
  "tools": [
    {
      "id": "claude-code",
      "name": "Claude Code",
      "adapter": "statusline",
      "bindings": {"enter": "Enter", "escape": "Escape"},
      "command": "claude",
      "cwd": "~/code/project"
    },
    {
      "id": "codex",
      "name": "Codex",
      "adapter": "wrapper",
      "bindings": {"ctrl-c": "C-c"}
    }
  ],
  "session_launcher": "auto",
  "asr": {
    "engine": "faster-whisper",
    "model": "base",
    "device": "cpu",
    "language": null
  }
}
```

## Host-side session sources

Unchanged from v1: the daemon watches `~/.vibestick/sessions/*.json`,
one file per CLI session, written by per-tool adapters
(`host/adapters/claude_code_statusline.py`, `generic_wrapper.sh`, or
anything that drops a STATUS-schema JSON file there).
