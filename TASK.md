# Vibe Stick Master Task List

> Last reviewed: 2026-07-30. This is the single project task list. Historical
> implementation notes belong in Git history, issues, and release notes.

## Completed

### Product and firmware

- [x] Ship Vibe Stick firmware for M5StickC Plus and M5StickS3.
- [x] Implement the BLE GATT protocol, session navigation, voice recording,
  transcript confirmation, Vibe Mic mode, YOLO mode, power-button navigation,
  orientation handling, and device identity reporting.
- [x] Implement configurable Vibe Mic HID shortcuts (F13–F24; defaults A=F14,
  B=F15), including firmware validation, BLE synchronization, Host settings,
  regression coverage, and builds for both boards.
- [x] Implement Chinese font rendering, microphone PDM capture, resampling,
  DC removal, and gain adjustment.
- [x] Build both PlatformIO targets successfully in the current release line.

### HostCore and desktop application

- [x] Implement the TypeScript HostCore: versioned contracts, configuration,
  sessions, routing, BLE bridge, diagnostics, ASR settings, local model
  download/apply flow, YOLO delivery, and Linux Vibe Mic support.
- [x] Implement the Tauri desktop application with an Overview, Sessions,
  Voice, and Settings experience.
- [x] Provide owner handoff so the legacy Python host and HostCore do not claim
  the BLE device at the same time.
- [x] Add session discovery for Claude Code, Codex, OpenCode, and Kimi CLI.
- [x] Add reconnect actions, connection state in the system tray, close-to-tray
  behavior, startup registration, and a minimum desktop window size.
- [x] Add real English, Simplified Chinese, and follow-system language settings
  with persistence.
- [x] Add system, light, and dark appearance settings; fix light-theme selected
  controls so their labels remain readable.
- [x] Replace the non-standard Linux icon bundle with standard hicolor icon
  sizes and confirm the packaged `.desktop` entry points to the app icon.
- [x] Redesign the Overview around concise device status chips, Latest activity,
  and Current target; remove the obsolete transmission-record panel.

### Packaging, quality, and open source

- [x] Align the desktop package with the Vibe Stick product name and 0.2.1
  release line.
- [x] Build and inspect the Linux Debian package; it contains the desktop entry
  and 32px, 128px, and HiDPI hicolor application icons.
- [x] Add a dedicated Linux `package:deb` command to avoid unnecessary package
  targets during Linux CI.
- [x] Update GitHub Actions for Node.js 24, current Tauri packaging, dynamic
  Linux Python helper discovery, TypeScript tests, Python tests, and both
  firmware targets.
- [x] Resolve production npm audit findings; current HostCore and desktop
  production dependency audits report no known vulnerabilities.
- [x] Add an open-source README, a desktop-app screenshot, diagnostics privacy
  guidance, and the MIT License.
- [x] Verify HostCore tests (47 passing), Python tests (280 passing, 1 skipped),
  frontend build, Rust check, and both firmware builds.

## Manual verification before making Vibe Stick the default host

### Device and firmware matrix

- [ ] Flash and connect an M5StickC Plus. Confirm the app reports the C Plus
  model, the expected 0.2.x firmware version, and the correct product artwork.
- [ ] Flash and connect an M5StickS3. Confirm the app reports the S3 model, the
  expected 0.2.x firmware version, and the correct product artwork.
- [ ] On both devices, enter Vibe Mic and verify A=F14 and B=F15 through native
  BLE HID and the Linux fallback.
- [ ] Save A=F13 and B=F24, restart/reconnect, verify the changed bindings, and
  restore the defaults.
- [ ] Verify that screen updates do not visibly flicker during normal status,
  activity, and recording updates; use partial refresh where hardware support
  permits it.
- [ ] Make the firmware's device-reported version consistently use the 0.2.x
  release scheme.

### Voice, input, and device behavior

- [ ] With `ydotool` or `wtype` available, send Chinese YOLO text to a real
  focused Wayland/X11 target and verify A=Enter and B=Escape twice.
- [ ] Record through Vibe Mic in a real PipeWire application; verify source
  selection during recording and restoration after stopping.
- [ ] Download each supported local ASR model, observe progress, apply it, then
  verify that a real recording is transcribed with the selected model.
- [ ] Pair and manage more than one physical Stick in Device setup, including
  reconnecting the selected device and showing clear per-device state.

### Desktop and platform matrix

- [ ] Smoke-test the Linux Tauri package in a normal desktop session: launch,
  owner handoff, reconnect, startup enable/remove, upgrade, uninstall, and
  fallback to the legacy Python host.
- [ ] Build, install, and smoke-test the Tauri package on macOS, including
  native BLE, focused-input permission, and login-startup behavior.
- [ ] Build, install, and smoke-test the Tauri package on Windows, including
  native BLE, focused-input permission, and login-startup behavior.
- [ ] Confirm macOS notarization and Windows code-signing requirements before a
  public release.

## Release follow-up

- [ ] Run the full GitHub Actions release matrix from a version tag and confirm
  firmware, Python compatibility artifacts, and desktop artifacts are attached
  to the GitHub release.
- [ ] Publish release notes with supported boards, platform limitations,
  migration/rollback instructions, and the manual verification results above.
- [ ] Promote HostCore to the default connection owner only after every manual
  verification item passes on the supported platforms.
