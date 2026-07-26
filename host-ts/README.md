# VibeStick TypeScript Host 2.0

This is the new cross-platform TypeScript Host 2.0 runtime, developed
alongside—not in place of—the supported Python 1.x daemon. Its React +
Electron desktop control center lives in [`desktop/`](desktop/). Platform
capabilities are added only after this core conforms to `../contracts/v1`.

```bash
npm install
npm test
npm start -- --config ~/.vibestick/config.json
```

The test suite reads the same versioned JSON fixtures as Python.  Do not copy
or alter product semantics in platform UI code: add them here and prove them
through a contract fixture first.

On Linux, `host/tools/ble_gatt_helper.py` remains the verified full-capability
adapter: it supplies GATT, PipeWire Vibe Mic, keyboard fallback, focused input,
and session delivery. The TS app speaks JSON-lines to it. Host 2.0 also now
has a native Noble GATT transport for macOS/Windows (and opt-in Linux via
`--native-ble`), so those platforms can connect and synchronize the Stick
without the Python daemon. It deliberately reports keyboard delivery, virtual
microphone, and Agent CLI session delivery as unavailable until their platform
adapters are implemented and tested. Native macOS/Windows YOLO focused input
is the explicit exception: it uses online ASR plus OS-focused-input permission,
never a selected Agent CLI session.

For Linux TS-owner verification (stop the Python daemon first), supply its
existing virtual environment as the helper executable:

```bash
npm start -- --linux-helper ../host/.venv/bin/python
```

The CLI dashboard remains useful without `--linux-helper`; it is explicitly
degraded and does not claim to own the Stick.

The desktop shell remains in preview until Host 2.0 owns the BLE link; it
never presents unavailable BLE, HID, or Vibe Mic capabilities as usable.

The cross-platform login lifecycle model also carries the executable's
arguments and non-secret runtime environment. This is needed when an Electron
package launches the bundled HostCore through Electron's Node compatibility
mode: systemd receives an `Environment` entry, LaunchAgent receives
`EnvironmentVariables`, and Windows receives a user-local wrapper consumed by
Task Scheduler. Registration itself remains an explicit user action; Host 2.0
never silently installs a service or replaces Python 1.x.

For support, `GET /api/diagnostics` downloads a versioned JSON diagnostic
report from the loopback host. It contains platform/runtime and capability
summaries only. API keys, paths, commands, bindings, session names, transcript
content, tails, and audio are deliberately omitted.

Host 2.0 currently implements its own OpenAI-compatible online ASR path. Set
`asr.engine` to `"online"` and provide `asr.online.api_key` in the shared
configuration before it will advertise Agent ASR as available. The existing
local faster-whisper path remains part of Python 1.x until a TS-native local
provider is packaged.

See [the Host 2.0 migration guide](../docs/host-2-migration.md) for safe owner
handoff, capability limits, online-ASR testing, login startup, rollback, and
uninstall guidance.
