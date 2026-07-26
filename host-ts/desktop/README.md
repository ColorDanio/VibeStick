# VibeStick Host 2.0 desktop

This is the cross-platform React + Electron control center for the TypeScript Host 2.0 runtime. It remains separate from the Python 1.x dashboard: only one implementation may own the Stick BLE link at a time.

```bash
npm install
npm run dev
npm run build
VIBESTICK_DESKTOP_URL=http://127.0.0.1:5174 npm run desktop
```

The UI reads the loopback-only Host 2.0 API at `127.0.0.1:7861/api/desktop`. If it is not running, it explicitly shows preview/standby state rather than pretending it controls BLE or audio.

Electron is a thin cross-platform native shell and starts the shared TypeScript `HostCore` CLI when bundled. Platform-native BLE, audio and lifecycle adapters remain behind the same contracts.

For Linux development, opt into the existing audited BlueZ/PipeWire bridge with
`VIBESTICK_LINUX_HELPER=/absolute/path/to/python npm run desktop`. This starts
Host 2.0 with that executable as the helper; it does not stop Python 1.x or
steal the BLE owner lock. If Python 1.x owns the Stick, the UI reports the
conflict as degraded until the user explicitly switches owners.

On macOS and Windows the packaged desktop app starts the TypeScript-native
Noble GATT transport automatically. It can own the BLE link and synchronize
the Stick, but it intentionally does **not** claim Vibe Mic, keyboard/focused
input, or session delivery until native adapters for those capabilities are
implemented and tested. Linux can opt into the same transport for bring-up via
`VIBESTICK_NATIVE_BLE=1`; its Python helper remains the supported full-feature
path.

The operating system must grant the desktop app Bluetooth permission. A denied,
powered-off, unsupported, or missing adapter is reported as a Host 2.0 runtime
failure; the app never falls back to forcibly taking Python 1.x's BLE owner
lock. Pairing, reconnect, MTU, and permission flows still need physical macOS
and Windows validation.

`npm run package:dir` produces an unpacked package for the current platform.
Release targets are declared for AppImage/deb (Linux), dmg/zip (macOS), and
NSIS/zip (Windows). macOS notarization and Windows signing are release
pipeline responsibilities, not silently bypassed at build time.

CI packages this desktop app on native Linux, macOS, and Windows runners and
checks that the bundled HostCore resource is present. Tag releases attach
those native desktop artifacts alongside firmware and Python 1.x packages.
This verifies packaging compatibility only; it is not evidence that BLE,
virtual audio, permissions, notarization, or code signing have completed on a
platform.
