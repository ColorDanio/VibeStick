# VibeConn 2.0 desktop

This is the cross-platform React + Electron control center for the TypeScript VibeConn 2.0 runtime. It remains separate from the Python 1.x dashboard: only one implementation may own the Stick BLE link at a time.

```bash
npm install
npm run dev
npm run build
VIBESTICK_DESKTOP_URL=http://127.0.0.1:5174 npm run desktop
```

The UI reads the loopback-only Host 2.0 API at `127.0.0.1:7861/api/desktop`. If it is not running, it explicitly shows preview/standby state rather than pretending it controls BLE or audio.

Electron is a thin cross-platform native shell and starts the shared TypeScript `HostCore` CLI when bundled. Platform-native BLE, audio and lifecycle adapters remain behind the same contracts.

In the packaged desktop app, **Settings → Start at login** explicitly registers or
removes a per-user startup entry: a systemd user service on Linux, a LaunchAgent
on macOS, or a Task Scheduler entry on Windows. It starts the Electron shell,
which in turn starts its own HostCore child. The action writes only the minimal
Linux graphical-session environment needed for the shell, never persists secrets,
and never stops Python 1.x or takes its BLE lock automatically.
When enabled from the repository launcher, the registration also retains the
non-secret Python compatibility-runtime path selected for Linux. It therefore
starts with the same BLE, Vibe Mic, local ASR and session discovery adapters
after login instead of falling back to a degraded native preview.

For Linux development, opt into the existing audited BlueZ/PipeWire bridge with
`VIBESTICK_LINUX_HELPER=/absolute/path/to/python npm run desktop`. This starts
Host 2.0 with that executable as the helper; it does not stop Python 1.x or
steal the BLE owner lock. If Python 1.x owns the Stick, the UI reports the
conflict as degraded until the user explicitly switches owners.

When Python 1.x is the current BLE owner, the packaged desktop shows
**Release to Host 2.0**. It is a user-triggered loopback request to Python's
dashboard; Python gracefully stops and releases its BLE lock, while Host 2.0
retries normally. The desktop never terminates Python, changes its settings,
or requests release automatically.

On macOS and Windows the packaged desktop app starts the TypeScript-native
Noble GATT transport automatically. It can own the BLE link and synchronize
the Stick, but it intentionally does **not** claim Vibe Mic, keyboard, or
session delivery until native adapters for those capabilities are implemented
and tested. The deliberate exception is **YOLO**: on macOS and Windows,
online-ASR text can be sent only to the OS's currently focused app
(Accessibility permission on macOS; normal-integrity foreground app on Windows).
Before it is marked ready, use **Settings → Test permission**. That explicit
probe only checks a foreground target and OS permission; it never types text or
presses a key. The button appears only when the native macOS/Windows adapter
actually exposes that probe; Linux never presents a misleading unsupported test.
Linux can opt into the same transport for bring-up via
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

Noble is a desktop production dependency so packaging can rebuild the active
platform's binding for Electron rather than copying a normal-Node binary from
HostCore. Linux rebuilds the HCI binding; macOS/Windows rebuild Noble's own
binding. The Linux CI job also loads Noble from the final unpacked Electron
resource without scanning or connecting BLE, which catches ABI mismatches.
