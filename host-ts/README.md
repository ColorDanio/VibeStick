# VibeStick TypeScript Host Core

This is the new cross-platform host domain core, developed alongside—not in
place of—the supported Python traditional daemon.  It has no real BLE,
keyboard, microphone, or lifecycle side effects yet.  Those are capability
adapters added only after this core conforms to `../contracts/v1`.

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
