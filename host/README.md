# VibeStick host daemon

Bridges AI coding CLI sessions (Claude Code, Codex, Kimi CLI, opencode, ...)
running on this machine to a VibeStick M5StickC Plus companion device over BLE.
See `../docs/protocol.md` for the wire protocol.

## Install

```sh
cd host
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"   # or plain: pip install -e host/
# optional, for local Whisper voice transcription:
.venv/bin/pip install -e ".[asr]"
```

## Run

```sh
vibestickd            # or: python -m vibestick.daemon
vibestickd -v         # debug logging
vibestick-web         # daemon + dashboard, and opens the browser
vibestickd --no-dashboard      # disable the dashboard web UI
vibestickd --setup-port 8080   # dashboard on a different port
vibestickd --config /path/to/config.json
```

The daemon serves the **dashboard** at http://127.0.0.1:7860 by default
(`--no-dashboard` disables it; `--setup` is kept as a no-op alias for
compatibility). If the port is busy, the daemon logs a warning and runs
on without it.

The daemon scans for a BLE peripheral named `VibeStick`, connects, subscribes
to the INPUT/COMMAND/AUDIO characteristics, and pushes STATUS/SESSIONS/TOOLS/
VOICE payloads whenever they change. It reconnects automatically with
exponential backoff. No device nearby yet? The daemon just keeps retrying.

On Linux, bleak needs BlueZ; your user typically needs to be in the
`bluetooth` group (or run with suitable permissions).

## Configuration

The daemon reads `~/.vibestick/config.json` (created with sensible defaults
on first run: Claude Code via the statusline adapter, plus codex, opencode
and kimi-cli via the wrapper adapter). Schema — see `../docs/protocol.md`:

```json
{
  "tools": [
    {
      "id": "claude-code",
      "name": "Claude Code",
      "adapter": "statusline",
      "bindings": {"enter": "Enter", "escape": "Escape"}
    },
    {
      "id": "codex",
      "name": "Codex",
      "adapter": "wrapper",
      "bindings": {"ctrl-c": "C-c", "enter": "Enter", "escape": "Escape"}
    }
  ],
  "asr": {"engine": "faster-whisper", "model": "small", "device": "cpu", "language": null}
}
```

- `tools[].id` must match the `tool` field in session state files.
- `adapter` is `statusline` or `wrapper` (informational for now).
- `bindings` maps device function ids to key sequences (see "Key bindings").
- `delivery_hint` is an optional free-text note shown in the setup UI.
- `asr` configures voice transcription (see "Voice / ASR").

The easiest way to edit the config is the **dashboard** (served by default):

```sh
vibestickd                  # then open http://127.0.0.1:7860
```

It is a stdlib-only local web app (no extra dependencies): a sidebar
dashboard with four pages, refreshed from `GET /api/status` every 2 s:

- **Overview**: card dashboard — stick connection (breathing-dot
  indicator, address, connected-since/last-sync/uptime), Agents count,
  Sessions count (running/foreground), Voice (ASR engine/model/install
  state), virtual mic state, and recent activity with tail snippets.
- **Agents**: master-detail monitor — left rail with per-agent status
  dots and thinking badges, detail panel with a hero card
  (adapter/delivery badges, inline launch-command editor) and a
  session table (fg dots, pulsing thinking badges, relative times,
  tail accordion, per-session "select on stick" / "new session" actions
  via `POST /api/command`). Auto-refreshes every 3 s without flicker
  (fingerprinted partial updates; focus and expanded rows survive).
- **Settings**: grouped settings center — General (feature toggles as
  switches), Tools (expandable tool cards with bindings editor and
  confirm-delete), Voice (ASR engine plus segmented model/device
  selectors; CUDA segment disabled with a reason when no GPU),
  Advanced. Changes mark a dirty counter with a sticky Save/Discard bar.
  View state (selected agent, expanded cards) lives in the URL hash and
  survives reloads.
- **Voice & Mic**: virtual-microphone state and toggle, plus live ASR
  status (faster-whisper version when installed, model, CUDA device
  count, peak-normalization note) and the recent-transcriptions list.

Saving writes `config.json` atomically; the running daemon picks up
changes automatically (mtime watch). The JSON API is `GET/POST
/api/config`, `GET /api/status`, and `POST /api/command` (forwards a
device command dict like `{"cmd": "session.select", "id": ...}` into the
daemon); static assets live in `vibestick/assets/`.

## Session discovery

Adapter files only exist for CLIs launched through an adapter. To show
the CLIs' **real** sessions anyway, the daemon scans each tool's own
on-disk session store every ~10 s (per-tool `discover` flag, default on,
checkbox in the dashboard; capped at the 10 most recent sessions per
tool):

- **claude-code**: `~/.claude/projects/*/*.jsonl` — name from the
  transcript's `cwd`, `last` = most recent assistant text message.
- **codex**: `~/.codex/sessions/**/rollout-*.jsonl` — name from the
  `session_meta` cwd, `last` = most recent assistant message.
- **kimi-cli**: `~/.kimi-code/sessions/wd_*/session_*/` — name from
  `state.json`'s title (best-effort, no deep parsing).
- **opencode**: `~/.local/share/opencode/opencode.db` — sqlite (stdlib,
  read-only): title, directory, even cost.

Discovered sessions appear as `disc:<hash>` entries (compact ids that
fit the device's session-id buffer) — selectable like adapter sessions,
with `ctx_pct` = -1 and `updated` = file mtime. Each also carries a
conversation **tail** (v2.2): the last few user/assistant text lines
(`user:` / `assistant:` prefixed, ~60 chars each) shown on the device
and in the dashboard. System-injection blobs (environment contexts,
system reminders) are filtered out; unparseable files are skipped, never
fatal. A discovered session shows `running` only while its mtime is
recent (< 3 min) AND a matching process is alive; otherwise `idle`.
Precedence per tool: **adapter files > discovered sessions > presence** —
no duplicates. Parsing is defensive and cached by mtime, so scans stay
cheap.

## Process presence watcher

Adapters are the primary source of session state, but a CLI launched
without an adapter (opencode without `vibe_wrap`, a kimi session started
before hooks were registered) would be invisible. Every ~5 s the daemon
scans `/proc/*/cmdline` for processes whose executable name matches the
tool's configured `process` name (defaults: claude, codex, opencode,
kimi). Linux only, no dependencies.

Matching is deliberately strict:

- the real binary (`/proc/PID/exe`) must match by exact basename, or
  argv[0] exactly; argv[1] only counts when argv[0] is a known
  interpreter (`python`/`python3.x`/`node`) — console scripts like
  `python3 /usr/local/bin/kimi` are matched;
- desktop applications installed in a `<name>-desktop` directory
  (electron apps such as codex-desktop) are explicitly **not** the CLI
  and are excluded, as are near-miss names like `codex-update-manager`.

Precedence per tool: **adapter files > discovered sessions > presence**.
Presence only kicks in when a tool has neither adapter files nor
discovered sessions; then a matching process makes the tool show
`running`, and the daemon synthesizes one session (`id` = `proc:<pid>`,
name = process cwd basename — or `<name> (pid <pid>)` when the cwd is
generic like an install dir), so the device's sessions screen lists it
and it is selectable like any adapter session. STATUS shows
`ctx_pct`/`cost_usd` = -1 and an empty `last`. Presence sessions carry
no `tmux`/`tty` delivery info, so messages sent to them are logged and
dropped. When the process exits, the synthesized session disappears and
the tool reverts to `idle`. Disable the watcher via the dashboard's
Features section (`features.process_watcher`).

## Key bindings

Each tool's `bindings` maps a function id (shown in the device's tool view,
after `status`/`sessions`/`voice`) to a key sequence delivered to the
tool's active session when activated (`fn.activate`):

- `ctrl-c`, `alt-x`, `shift-tab`, ... → tmux modifiers (`C-c`, `M-x`, `S-Tab`);
  tmux-style values like `C-c` also work as-is
- named keys: `enter`, `escape`, `tab`, `space`, `backspace`, `delete`,
  `up`/`down`/`left`/`right`, `home`, `end`, `pageup`, `pagedown`, `f1`-`f12`
- anything else (e.g. `yes, continue`) is sent as literal text
  (`tmux send-keys -l`)

Delivery uses the session's `tmux` pane or `tty`, exactly like message
delivery.

## Device commands (v2.1)

- **`fg` (foreground dot)**: each SESSIONS entry carries `fg: bool`.
  Adapter-reported `fg` in the session file wins (the Kimi hook writes
  `fg: true` — its state file exists exactly between SessionStart and
  SessionEnd); presence sessions are always `fg`; otherwise heuristic:
  session file mtime < 3 min and the tool's process is alive.
- **`inference.cancel`**: sends the selected tool's `cancel` key binding
  (default `Escape`, overridable via `bindings.cancel`, which is
  host-side only and never listed as a device function) to the active
  session's delivery target. Without a delivery target the daemon pushes
  STATUS `state: "error"` with an explanation in `last`.
- **`session.new`**: opens a new tmux window (anchored at the selected
  tool's existing tmux pane) running the tool's CLI launch command
  (`command` config field, default: the `process` name), then
  auto-selects the new session once it surfaces via an adapter file or
  discovery (30 s timeout). Without tmux delivery or a launch command it
  replies STATUS `state: "error"`, `last: "new session unsupported"`.
- **Queue semantics**: messages for a busy (`running`) session are
  queued host-side (per-session FIFO, cap 8) and flushed in order once
  the session goes idle/waiting — see "Voice / ASR → Send queue".
- `fn.activate` remains supported for backwards compatibility; the v2.1
  device UI no longer emits it.

## Desktop app

`vibestick-app` opens the dashboard as a native desktop window:

- **attach mode** (default when a daemon is running): opens a window on
  the existing dashboard at http://127.0.0.1:7860 — closing the window
  does not touch the daemon;
- **spawn mode** (no daemon): starts the daemon itself (same path as
  `vibestick-web`) and stops it gracefully when the window closes.

Window backend: pywebview when installed (`pip install 'vibestick[app]'`,
needs GTK/WebKitGTK Python bindings), otherwise `google-chrome --app=…`
in a dedicated profile (`~/.vibestick/chrome-app`) — the window is
titled "VibeStick" at 1100×750 with the app icon.

GNOME integration (run once):

```sh
vibestick-app --install-desktop
```

installs `~/.local/share/applications/vibestick.desktop` (application
menu entry), `~/.local/share/icons/vibestick.png`, and
`~/.config/autostart/vibestickd.desktop` so the daemon starts in the
background at login and `vibestick-app` only ever attaches.

## Voice / ASR

The device streams 8 kHz 8-bit unsigned PCM over the AUDIO characteristic
(max ~25 s per recording). On `voice.stop` the daemon transcribes with the
configured ASR engine, pushes the transcript via VOICE, and `voice.confirm`
delivers it as a message to the selected tool's active session.

**Send queue**: messages (typed or transcribed) for a busy
(`state == "running"`) session are queued host-side instead of dropped
— per-session FIFO, capped at 8 (oldest dropped beyond that), flushed
in order (~300 ms apart) once the session goes idle/waiting. STATUS
carries `queued: N` while pending; the dashboard Agents detail shows a
`queued N` badge per session. Delivery failures (no tmux/tty target)
are not retried — the message is dropped once with a STATUS error.

Every transcription attempt is logged: a ~20-entry ring buffer plus
`~/.vibestick/voice-log.jsonl` (timestamp, audio duration, processing
time, model, detected language, clip file, ok / no-speech / error, text
preview or failure reason). The raw audio of the last 5 recordings is
kept in `~/.vibestick/clips/clip-1..5.wav` (rotating); replay one
offline across models with `host/tools/asr_debug.py <wav>` for
diagnosis. The last attempts show on the dashboard's Voice & Mic
page and in `/api/status` under `asr.recent`.
Input is peak-normalized (99th percentile → 0.7, gain capped at 30) before
resampling to 16 kHz, the Silero VAD threshold is relaxed
(`threshold=0.3`) so quiet mic speech is not filtered away, and an
`initial_prompt` biases output toward simplified Chinese + English
(auto language detection stays on).

Two engines:

- `faster-whisper` (default): local Whisper. Optional dependency —
  install with `pip install 'vibestick[asr]'` (pulls in `faster-whisper`,
  `numpy` and `scipy` — scipy enables polyphase resampling and the
  DC-blocker filter; without it the pipeline falls back to linear
  resampling). Settings: `model` (`tiny`/`base`/`small`, default `small` — `base` is auto-migrated to `small` on load), `device`
  (`cpu`), `language` (`null` = auto-detect). If the packages are missing,
  the daemon stays up and VOICE shows an error instead.
- `command`: run any external program. `asr.command` is a shell-style
  template; the daemon appends the path of a temporary WAV file as the last
  argument and reads the transcript from stdout. Example:
  `"asr": {"engine": "command", "command": "whisper-cli -m model.bin -f"}`.

## Session state files

Adapters drop one JSON file per CLI session into `~/.vibestick/sessions/`,
using the STATUS schema from the protocol doc, plus an optional `id` and
delivery fields (`tmux` or `tty`). The daemon polls this directory once a
second, prunes sessions with no update for >30 minutes, and tracks a
selected tool plus its active session (both switchable from the device).

## Claude Code statusLine adapter

Add to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "python3 /path/to/host/adapters/claude_code_statusline.py"
  }
}
```

Claude Code pipes session JSON on stdin; the adapter writes
`~/.vibestick/sessions/<session_id>.json` and records `$TMUX_PANE` (when set)
so messages can be delivered back into the session.

## Kimi Code CLI hook adapter

Kimi Code has a proper hooks mechanism — better than the generic wrapper.
Register `host/adapters/kimi_hook.py` in `~/.kimi-code/config.toml`
(the full snippet is in the file's header comment):

```toml
[[hooks]]
event = "SessionStart"
command = "python3 /path/to/host/adapters/kimi_hook.py"
# ... same command for UserPromptSubmit, PreToolUse, Stop, SessionEnd
```

Mapping: SessionStart/UserPromptSubmit/PreToolUse → `running`,
Stop/Interrupt → `waiting`, SessionEnd → state file removed.
Hooks load at session start, so restart kimi after registering.

## Generic wrapper (codex, opencode, ...)

```sh
. /path/to/host/adapters/generic_wrapper.sh
vibe_wrap codex          # instead of plain `codex`
```

The wrapper emits a state file on start (`running`) and on exit (`idle`),
so otherwise-unsupported tools at least show presence on the device.

## Message delivery

When you type a message on the device (INPUT notify), the daemon delivers
it to the **active** session. Target resolution order (per-tool
`delivery` config: `"auto"` default, `"tmux"`, `"tty"`):

- `tmux` pane id → `tmux send-keys -t <pane> -- <text> Enter`
- `tty` path → bytes are injected into the terminal's input queue with
  the **TIOCSTI** ioctl, one byte per ioctl (writing the pts slave
  directly would only *display* the text, not deliver it). Presence/
  discovered sessions inherit the pts of the CLI process (read from
  `/proc/<pid>/stat`). A **safety gate** applies: the injection only
  happens while the process is alive, its controlling terminal is still
  that pts, the process (or an ancestor) is in the terminal's
  foreground process group, and the pts is writable — otherwise the
  message counts as undeliverable. Kernels with
  `dev.tty.legacy_tiocsti=0` reject TIOCSTI (`sudo sysctl
  dev.tty.legacy_tiocsti=1` enables it); failures log the current
  sysctl value.
- neither → the message is logged and dropped

All delivery is best-effort with timeouts; failures are logged, never fatal.
`inference.cancel` uses the same path (Escape = `\x1b` on a pts).

## Virtual microphone (PTT mic mode)

When the firmware sends `voice.start` with `"mode": "mic"`, the daemon
routes the AUDIO PCM (8 kHz u8 mono) into a **virtual microphone**
instead of the ASR pipeline: a persistent PipeWire adapter node
(`support.null-audio-sink`, `media.class=Audio/Source/Virtual`, dsp
monitor, with the `device.*` properties GNOME Settings needs to list
it) registers an `Audio/Source` named **"VibeStick Mic"** that appears
in the system input device list. A per-press `pw-cat --playback --raw`
feeder (linked into the node's input ports with `pw-link`) writes the
frames, applying a small software gain (x3) to compensate for monitor
path attenuation. Silence between PTT presses is automatic. Requires
PipeWire tools (`pw-cli`, `pw-cat`, `pw-link`); missing binaries
degrade to log warnings, and the node is reused if present / removed on
daemon exit. Disable with `"mic": {"enabled": false}` in config.json.
ASR mode (no `mode` field) is unaffected and never touches the virtual
mic.

## Tests

```sh
cd host
.venv/bin/pytest
```
