# VibeConn 2.0 (TypeScript refactor)

This is the new cross-platform TypeScript VibeConn 2.0 runtime, developed
alongside—not in place of—the supported Python 1.x daemon. Its React +
Tauri desktop control center lives in [`desktop/`](desktop/). Platform
capabilities are added only after this core conforms to `../contracts/v1`.

```bash
npm install
npm test
npm start -- --config ~/.vibestick/config.json
```

For repository development, prefer the versioned launcher from the project
root: `tools/vibeconn --implementation 2`. It starts the Tauri UI and its
own HostCore daemon. `tools/vibeconn` without an implementation remains the
stable VibeConn 1.x command.

The test suite reads the same versioned JSON fixtures as Python.  Do not copy
or alter product semantics in platform UI code: add them here and prove them
through a contract fixture first.

On Linux, `host/tools/ble_gatt_helper.py` remains the verified full-capability
adapter: it supplies GATT, keyboard fallback, focused input, and session
delivery. A separate one-shot read-only compatibility adapter supplies the
same Claude/Codex/OpenCode/Kimi session discovery and terminal metadata as
1.x; TS still owns selection, BLE synchronization and command policy. The TS
app speaks JSON-lines to these helpers. Host 2.0 also has a native Noble
GATT transport for macOS/Windows (and opt-in Linux via `--native-ble`), so
those platforms can connect and synchronize the Stick without the Python
daemon. The Linux native route now owns its PipeWire **Vibe Mic** source and
`pw-cat` feeder in TypeScript; it does not invoke the Python helper for that
capability. It deliberately still reports keyboard delivery and Agent CLI
session delivery as unavailable on Windows. Linux/macOS native BLE now deliver
Agent CLI text, bindings, and new panes to the **selected managed tmux/zellij
session** through a TS adapter; a plain PID/tty has no safe native injection
fallback and is rejected rather than redirected globally. Native YOLO focused input is another explicit exception: Linux
uses `ydotool` then `wtype` with argv-only calls; macOS uses System Events and
Windows uses SendInput. Each platform requires online ASR and a successful
explicit focused-input probe, and never targets a selected Agent CLI session.

For Linux TS-owner verification, use the app's explicit **Release to Host 2.0**
handoff, or stop Python 1.x first. Supply its existing virtual environment as
the helper executable:

```bash
npm start -- --linux-helper ../host/.venv/bin/python
```

The CLI dashboard remains useful without `--linux-helper`; it is explicitly
degraded and does not claim to own the Stick.

The desktop shell remains in preview until Host 2.0 owns the BLE link; it
never presents unavailable BLE, HID, or Vibe Mic capabilities as usable.

The cross-platform login lifecycle model also carries the executable's
arguments and non-secret runtime environment. This is needed when the Tauri
package launches the bundled HostCore through its versioned Node sidecar
mode: systemd receives an `Environment` entry, LaunchAgent receives
`EnvironmentVariables`, and Windows receives a user-local wrapper consumed by
Task Scheduler. Registration itself remains an explicit user action; Host 2.0
never silently installs a service or replaces Python 1.x.

Packaged Linux builds include only the small compatibility entry scripts. They
use the user's installed VibeConn 1.x Python environment (selected by
`VIBESTICK_LINUX_HELPER` / `VIBECONN_PYTHON`) for its already-installed
Bleak, PipeWire, local-model and session-reader dependencies; they do not ship
or start a second Python daemon.

For support, `GET /api/diagnostics` downloads a versioned JSON diagnostic
report from the loopback host. It contains platform/runtime and capability
summaries only. API keys, paths, commands, bindings, session names, transcript
content, tails, and audio are deliberately omitted.

Host 2.0 implements its own OpenAI-compatible online ASR path. It also accepts
the existing `faster-whisper` and `command` configuration through a one-shot
local model adapter: recording state, BLE messages, mode routing and delivery
remain TypeScript-owned, while the already-installed Python model runtime is
used only to execute the model. The repository launcher supplies the matching
Python executable and adapter automatically on Linux. Packaged cross-platform
local-model distribution remains a later packaging task; use online ASR where
that runtime is not present.

See [the Host 2.0 migration guide](../docs/host-2-migration.md) for safe owner
handoff, capability limits, online-ASR testing, login startup, rollback, and
uninstall guidance.
