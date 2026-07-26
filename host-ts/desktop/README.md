# VibeConn 2.0 desktop

VibeConn 2.0 is a cross-platform **Tauri 2** desktop app.  Electron is not a
runtime or packaging dependency.  Tauri provides the native application window
and lifecycle boundary; the renderer remains React/TypeScript and the shared
TypeScript HostCore owns BLE, voice routing and Agent CLI state.

The user-facing app is an installed desktop window.  Vite on port 5174 is a
development-only renderer endpoint started by `npm run dev`; it is never a
product URL or a release requirement.

```bash
cd host-ts/desktop
npm install
npm run dev       # Tauri app + temporary local Vite server
npm run build     # platform-native Tauri bundle
```

On Linux, Tauri requires the system WebKit GTK development packages for local
builds.  The released app uses the system WebView and therefore does not bundle
Chromium.  The standard HostCore compatibility runtime is still resolved from
`VIBESTICK_LINUX_HELPER`, `VIBECONN_PYTHON`, or the installed VibeConn 1.x
launcher shebang.  It never steals Python 1.x BLE ownership: the user-triggered
**Release to VibeConn 2.0** command is the only handoff path.

The primary UI is **Overview**.  It presents the device and the Agent CLI menu
in one place.  Agent CLI is agent-first: Claude Code, Codex, OpenCode and Kimi
CLI are distinct selectable targets, and only human-readable session names are
shown.  The internal discovery identifier is never UI copy.

The current Tauri shell starts HostCore for local development.  Before release,
the HostCore Node runtime and the three audited Linux compatibility helpers are
bundled as versioned per-platform resources; that packaging work deliberately
comes before removing the stable Python 1.x release path.
