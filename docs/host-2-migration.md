# Host 2.0 migration and rollback

Host 2.0 is an optional TypeScript/Electron implementation. Python 1.x remains
the supported default while the three platform adapters reach feature parity.
Both implementations use the same Stick and may read the same configuration,
but **only one may own the BLE link at a time**.

## Choose an owner

Start with Python 1.x unless you are deliberately validating Host 2.0.

To hand the Stick to Host 2.0:

1. Start VibeStick Host 2.0. If Python 1.x is running, the Electron desktop
   shows **Release to Host 2.0**. This is an explicit user action: it sends
   Python's loopback `owner.release` command, which gracefully disconnects BLE,
   cancels daemon-owned work, and releases the shared lock. It does not delete
   configuration or sessions, and Host 2.0 never invokes it automatically.
2. Alternatively, stop the Python process/service using the method that
   started it (terminal, systemd user service, or the Python desktop app).
3. Confirm its dashboard at `http://127.0.0.1:7860` is no longer running.
4. Host 2.0 probes the Python dashboard before every first
   connection and reconnect attempt; while Python is running, Host 2.0 stays
   standby and does not scan, subscribe, or connect BLE.
5. Pair or authorize Bluetooth when the operating system asks. The Host 2.0
   Overview must say **BLE connected** before treating the Stick as controlled.

To return to Python 1.x, quit VibeStick Host 2.0 from its tray menu (not merely
close its window), optionally remove **Start at login** in Settings, then start
the Python daemon again. No firmware change or configuration conversion is
required for either direction.

## Capability matrix

| Capability | Python 1.x | Host 2.0 with Linux helper | Host 2.0 native macOS/Windows |
|---|---|---|---|
| BLE sessions/status | supported | verified | adapter implemented; hardware validation pending |
| Agent CLI voice delivery | supported | verified | not implemented |
| Vibe Mic virtual input | supported | helper verified; Linux native BLE TS adapter smoke-tested | not implemented |
| System HID fallback | supported | verified | not implemented |
| YOLO voice to focused app | Linux focused injector | verified | Linux native BLE TS adapter (`ydotool`/`wtype`) smoke-tested; macOS/Windows implemented, hardware validation pending |
| YOLO A=Enter, B=Escape×2 | supported | verified | Linux TS adapter covered; macOS/Windows implemented with focused-input permission |
| Local faster-whisper | supported | not in TS | not in TS |
| Online ASR | optional | supported | YOLO-only while session delivery is unavailable |

“Implemented” does not mean a platform has passed physical pairing, permission,
audio-driver, MTU, and reconnect testing. Host 2.0 reports unavailable
capabilities in its Overview instead of pretending they work.

## Desktop setup and lifecycle

The packaged desktop app owns only the HostCore process it launches. It never
stops Python 1.x, installs a service without a click, or bypasses operating
system permission prompts.

In **Settings → Start at login**, choose **Enable** to register a per-user
desktop startup entry. It uses a systemd user service on Linux, a LaunchAgent
on macOS, or Task Scheduler on Windows. The status chip is read-only and shows
whether the OS currently has that registration. Choose **Remove** before
uninstalling the desktop app or when returning permanently to Python 1.x.

On Linux, use the existing verified helper when testing Host 2.0:

```sh
cd host-ts
npm start -- --linux-helper ../host/.venv/bin/python
```

Do not run that helper concurrently with Python 1.x.

## Online ASR and YOLO

Host 2.0 requires an OpenAI-compatible online provider for Agent ASR and for
native macOS/Windows YOLO. Save the API URL, model, and key in Settings, then
select **Test provider**. The test makes an authenticated `GET /models`; it
does not send audio and never returns the API key to the UI. A successful test
only proves provider authentication/reachability, not microphone quality or
speech transcription. Restart Host 2.0 after changing ASR settings.

For macOS YOLO, grant the desktop app Accessibility permission. For Windows,
the target app must be the foreground window and must not run at a higher
integrity level than VibeStick Host. If focused input is refused, the Stick and
desktop diagnostics show an error; no text is silently redirected to a session.
Before the capability becomes ready, select **Settings → Test permission**.
This is an explicit non-injecting probe: it checks only the current foreground
target and OS accessibility/input permission, and never types text or sends
Enter/Escape. It is not a substitute for the pending physical macOS/Windows
end-to-end validation. The control is exposed only when the native macOS or
Windows adapter supports the probe, not on Linux's helper path.

## Safe rollback and support bundle

If Host 2.0 loses BLE, reports a capability error, or is unsuitable for your
workflow:

1. Use the tray **Quit** action to release its HostCore child and BLE link.
2. Use **Remove** under Start at login if it should not start next login.
3. Start Python 1.x again and verify its `:7860` dashboard connects to the
   Stick.
4. In Host 2.0, download the loopback diagnostics bundle before quitting if
   you need to report the issue. It intentionally excludes keys, paths,
   commands, session names, transcripts, tails, and audio.

Never force-kill both owners blindly or pair two hosts simultaneously. If the
link remains busy after a normal handoff, power-cycle the Stick, confirm only
one daemon is running, then start the intended owner.
