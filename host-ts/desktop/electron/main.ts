import { app, BrowserWindow, ipcMain, shell } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let windowRef: BrowserWindow | undefined;
let host: ChildProcess | undefined;
let hostStatus: { state: "starting" | "running" | "exited" | "missing"; detail?: string } = { state: "starting" };
const currentDir = dirname(fileURLToPath(import.meta.url));

if (!app.requestSingleInstanceLock()) app.quit();
else app.on("second-instance", () => {
  if (!windowRef) return;
  if (windowRef.isMinimized()) windowRef.restore();
  windowRef.focus();
});

/** Electron is deliberately a thin, cross-platform native shell; HostCore stays shared TypeScript. */
function startHostCore(): void {
  if (process.env.VIBESTICK_NO_CORE === "1") { hostStatus = { state: "missing", detail: "HostCore startup disabled" }; return; }
  const cli = app.isPackaged ? join(process.resourcesPath, "host-core", "cli.js") : resolve(currentDir, "../../dist/cli.js");
  if (!existsSync(cli)) { hostStatus = { state: "missing", detail: "HostCore executable is missing" }; return; }
  const args = [cli, "--port", "7861"];
  const helper = process.platform === "linux" ? process.env.VIBESTICK_LINUX_HELPER : undefined;
  if (helper) args.push("--linux-helper", helper);
  if (process.env.VIBESTICK_DEVICE_ADDRESS) args.push("--address", process.env.VIBESTICK_DEVICE_ADDRESS);
  host = spawn(process.execPath, args, {
    cwd: dirname(cli), env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "pipe", windowsHide: true,
  });
  let stderr = "";
  host.stderr?.on("data", (data) => { stderr = (stderr + String(data)).slice(-500); });
  host.once("spawn", () => { hostStatus = { state: "running" }; });
  host.once("error", (error) => { hostStatus = { state: "exited", detail: error.message }; });
  host.once("exit", (code) => { hostStatus = { state: "exited", detail: (stderr.trim() || `HostCore exited (${code ?? "unknown"})`).slice(-240) }; });
}

function createWindow(): void {
  windowRef = new BrowserWindow({
    width: 1280, height: 820, minWidth: 980, minHeight: 680, backgroundColor: "#15181c",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: join(currentDir, "preload.js") },
  });
  const devServer = process.env.VIBESTICK_DESKTOP_URL;
  if (devServer) void windowRef.loadURL(devServer); else void windowRef.loadFile(join(currentDir, "../dist/index.html"));
  windowRef.webContents.setWindowOpenHandler(({ url }) => { void shell.openExternal(url); return { action: "deny" }; });
}

void app.whenReady().then(() => {
  if (!app.hasSingleInstanceLock()) return;
  startHostCore(); createWindow();
  app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
ipcMain.handle("vibestick:host-status", () => hostStatus);
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => { host?.kill(); host = undefined; });
