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

On Linux, `host/tools/ble_gatt_helper.py` is the first real GATT capability
adapter. The TS app speaks JSON-lines to it; run it with the Python host
environment so its existing `bleak` dependency is available. It is not yet a
macOS/Windows release adapter, so those platforms correctly report BLE as
unavailable instead of attempting a partial connection.

For Linux TS-owner verification (stop the Python daemon first), supply its
existing virtual environment as the helper executable:

```bash
npm start -- --linux-helper ../host/.venv/bin/python
```

The CLI dashboard remains useful without `--linux-helper`; it is explicitly
degraded and does not claim to own the Stick.

The desktop shell remains in preview until Host 2.0 owns the BLE link; it
never presents unavailable BLE, HID, or Vibe Mic capabilities as usable.

Host 2.0 currently implements its own OpenAI-compatible online ASR path. Set
`asr.engine` to `"online"` and provide `asr.online.api_key` in the shared
configuration before it will advertise Agent ASR as available. The existing
local faster-whisper path remains part of Python 1.x until a TS-native local
provider is packaged.
