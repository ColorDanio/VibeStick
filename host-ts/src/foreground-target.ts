import { spawn } from "node:child_process";

export type ForegroundTarget = { app: string };

/** Identifies only the focused application, never its window title or contents. */
export class ForegroundTargetProbe {
  async current(): Promise<ForegroundTarget | undefined> {
    if (process.platform === "darwin") return this.macos();
    if (process.platform === "win32") return this.windows();
    return this.linux();
  }

  private async macos(): Promise<ForegroundTarget | undefined> {
    return toTarget(await output("osascript", ["-e", 'tell application "System Events" to get name of first application process whose frontmost is true']));
  }
  private async windows(): Promise<ForegroundTarget | undefined> {
    const script = "$h=(Add-Type '[DllImport(\"user32.dll\")]public static extern IntPtr GetForegroundWindow();' -Name F -Pas)::GetForegroundWindow(); if($h -ne [IntPtr]::Zero){(Get-Process -Id ((Get-Process | Where-Object {$_.MainWindowHandle -eq $h}).Id)).ProcessName}";
    return toTarget(await output("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]));
  }
  private async linux(): Promise<ForegroundTarget | undefined> {
    // Hyprland exposes an app class without requiring a window title.
    const hypr = await output("hyprctl", ["activewindow", "-j"]);
    if (hypr) {
      try {
        const parsed: unknown = JSON.parse(hypr);
        if (typeof parsed === "object" && parsed !== null && typeof (parsed as { class?: unknown }).class === "string") return toTarget((parsed as { class: string }).class);
      } catch { /* fall through */ }
    }
    // X11 fallback: resolve PID then /proc comm, never the window title.
    const pid = await output("xdotool", ["getwindowfocus", "getwindowpid"]);
    if (!pid || !/^\d+$/.test(pid.trim())) return undefined;
    return toTarget(await output("cat", [`/proc/${pid.trim()}/comm`]));
  }
}

function output(command: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true }); }
    catch { resolve(undefined); return; }
    let text = "";
    child.stdout?.on("data", (chunk: Buffer) => { text += chunk.toString(); });
    child.once("error", () => resolve(undefined));
    child.once("exit", (code) => resolve(code === 0 ? text : undefined));
  });
}
function toTarget(value: string | undefined): ForegroundTarget | undefined {
  const app = value?.trim().replace(/[\r\n]+/g, " ");
  return app ? { app: app.slice(0, 80) } : undefined;
}
