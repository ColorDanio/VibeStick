import { app, BrowserWindow, shell } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

let windowRef: BrowserWindow | undefined;
let host: ChildProcess | undefined;

/** Electron is deliberately a thin, cross-platform native shell; HostCore stays shared TypeScript. */
function startHostCore(): void {
  if (process.env.VIBESTICK_NO_CORE === "1") return;
  const cli = app.isPackaged ? join(process.resourcesPath, "host-core", "cli.js") : resolve(import.meta.dirname, "../../dist/cli.js");
  if (!existsSync(cli)) return;
  host = spawn(process.execPath, [cli], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "ignore", windowsHide: true });
}

function createWindow(): void {
  windowRef = new BrowserWindow({
    width: 1280, height: 820, minWidth: 980, minHeight: 680, backgroundColor: "#15181c",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const devServer = process.env.VIBESTICK_DESKTOP_URL;
  if (devServer) void windowRef.loadURL(devServer); else void windowRef.loadFile(join(import.meta.dirname, "../dist/index.html"));
  windowRef.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: "deny" }; });
}

void app.whenReady().then(() => { startHostCore(); createWindow(); app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) createWindow(); }); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => { host?.kill(); host = undefined; });
