import { app, BrowserWindow, ipcMain, Menu, nativeImage, shell, Tray } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";

let windowRef: BrowserWindow | undefined;
let host: ChildProcess | undefined;
let tray: Tray | undefined;
let quitting = false;
let hostStatus: { state: "starting" | "running" | "exited" | "missing"; detail?: string } = { state: "starting" };
let hostGeneration = 0;
const currentDir = dirname(fileURLToPath(import.meta.url));

if (!app.requestSingleInstanceLock()) app.quit();
else app.on("second-instance", () => {
  showWindow();
});

/** Electron is deliberately a thin, cross-platform native shell; HostCore stays shared TypeScript. */
function startHostCore(): void {
  const generation = ++hostGeneration;
  if (process.env.VIBESTICK_NO_CORE === "1") { hostStatus = { state: "missing", detail: "HostCore startup disabled" }; return; }
  const cli = app.isPackaged ? join(process.resourcesPath, "host-core", "cli.js") : resolve(currentDir, "../../dist/cli.js");
  if (!existsSync(cli)) { hostStatus = { state: "missing", detail: "HostCore executable is missing" }; return; }
  const args = [cli, "--port", "7861"];
  const helper = process.platform === "linux" ? process.env.VIBESTICK_LINUX_HELPER : undefined;
  if (helper) args.push("--linux-helper", helper);
  else if (process.platform !== "linux" || process.env.VIBESTICK_NATIVE_BLE === "1") args.push("--native-ble");
  if (process.env.VIBESTICK_DEVICE_ADDRESS) args.push("--address", process.env.VIBESTICK_DEVICE_ADDRESS);
  host = spawn(process.execPath, args, {
    cwd: dirname(cli), env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "pipe", windowsHide: true,
  });
  let stderr = "";
  host.stderr?.on("data", (data) => { stderr = (stderr + String(data)).slice(-500); });
  host.once("spawn", () => { if (generation === hostGeneration) hostStatus = { state: "running" }; });
  host.once("error", (error) => { if (generation === hostGeneration) hostStatus = { state: "exited", detail: error.message }; });
  host.once("exit", (code) => { if (generation === hostGeneration) hostStatus = { state: "exited", detail: (stderr.trim() || `HostCore exited (${code ?? "unknown"})`).slice(-240) }; });
}

async function restartHostCore(): Promise<typeof hostStatus> {
  const prior = host;
  host = undefined;
  if (prior && !prior.killed) {
    await new Promise<void>((resolve) => { prior.once("exit", () => resolve()); prior.kill(); setTimeout(resolve, 3000); });
  }
  hostStatus = { state: "starting" }; startHostCore(); return hostStatus;
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
  windowRef.on("close", (event) => { if (!quitting) { event.preventDefault(); windowRef?.hide(); } });
}

function showWindow(): void {
  if (!windowRef || windowRef.isDestroyed()) createWindow();
  if (windowRef?.isMinimized()) windowRef.restore();
  windowRef?.show(); windowRef?.focus();
}

function createTray(): void {
  const icon = nativeImage.createFromDataURL("data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiIgdmlld0JveD0iMCAwIDE2IDE2Ij48cmVjdCB4PSIxIiB5PSIxIiB3aWR0aD0iMTQiIGhlaWdodD0iMTQiIHJ4PSI0IiBmaWxsPSIjMjEyNzJiIiBzdHJva2U9IiM3YmUwYmQiLz48cGF0aCBkPSJtNCA1IDQgNiA0LTYiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzdiZTBiZCIgc3Ryb2tlLXdpZHRoPSIyIi8+PC9zdmc+");
  tray = new Tray(icon); tray.setToolTip("VibeStick Host 2.0");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Show VibeStick", click: showWindow },
    { label: "Restart Host 2.0", click: () => { void restartHostCore(); } },
    { type: "separator" },
    { label: "Quit", click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on("click", showWindow);
}

void app.whenReady().then(() => {
  if (!app.hasSingleInstanceLock()) return;
  startHostCore(); createWindow(); createTray();
  app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
ipcMain.handle("vibestick:host-status", () => hostStatus);
ipcMain.handle("vibestick:restart-host", () => restartHostCore());
ipcMain.handle("vibestick:login-startup", async (_event, action: unknown): Promise<{ ok: boolean; detail: string }> => {
  if (action !== "install" && action !== "uninstall") return { ok: false, detail: "Invalid login-startup action" };
  try {
    const coreDirectory = app.isPackaged ? join(process.resourcesPath, "host-core") : resolve(currentDir, "../../dist");
    const [{ desktopLifecyclePlan }, { executeLifecycle, nodeRunner }] = await Promise.all([
      import(pathToFileURL(join(coreDirectory, "desktop-lifecycle.js")).href),
      import(pathToFileURL(join(coreDirectory, "lifecycle-runner.js")).href),
    ]);
    const platform = process.platform === "darwin" || process.platform === "win32" ? process.platform : "linux";
    const appArguments = app.isPackaged ? [] : [app.getAppPath()];
    const plan = desktopLifecyclePlan({ platform, executable: process.execPath, appArguments, home: homedir(), uid: typeof process.getuid === "function" ? process.getuid() : 0, environment: process.env });
    await executeLifecycle(plan, action, nodeRunner);
    return { ok: true, detail: action === "install" ? "VibeStick Host will start at your next login." : "Login startup was removed." };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240) };
  }
});
app.on("before-quit", () => { quitting = true; host?.kill(); host = undefined; tray?.destroy(); tray = undefined; });
