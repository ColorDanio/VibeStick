/** OS registration plans. Execution is delegated to an elevated installer. */
export type HostPlatform = "linux" | "darwin" | "win32";
export interface LifecycleOptions { executable: string; configPath: string; home: string; uid: number; }
export interface ManagedFile { path: string; contents: string; }
export interface Invocation { command: string; args: string[]; }
export interface LifecyclePlan { files: ManagedFile[]; install: Invocation[]; uninstall: Invocation[]; }

const serviceName = "vibestick-ts";

/**
 * Produce idempotent per-user registration instructions.  The Electron
 * installer or CLI runner executes this plan; domain code never shells out.
 */
export function lifecyclePlan(platform: HostPlatform, options: LifecycleOptions): LifecyclePlan {
  const args = ["--config", options.configPath];
  if (platform === "linux") {
    const path = `${options.home}/.config/systemd/user/${serviceName}.service`;
    const contents = `[Unit]\nDescription=VibeStick TypeScript Host\nAfter=graphical-session.target\n\n[Service]\nType=simple\nExecStart=${systemdEscape(options.executable)} --config ${systemdEscape(options.configPath)}\nRestart=on-failure\nRestartSec=3\n\n[Install]\nWantedBy=default.target\n`;
    return { files: [{ path, contents }], install: [{ command: "systemctl", args: ["--user", "daemon-reload"] }, { command: "systemctl", args: ["--user", "enable", "--now", `${serviceName}.service`] }], uninstall: [{ command: "systemctl", args: ["--user", "disable", "--now", `${serviceName}.service`] }] };
  }
  if (platform === "darwin") {
    const label = "io.vibestick.host";
    const path = `${options.home}/Library/LaunchAgents/${label}.plist`;
    const contents = plist(label, options.executable, args);
    return { files: [{ path, contents }], install: [{ command: "launchctl", args: ["bootstrap", `gui/${options.uid}`, path] }], uninstall: [{ command: "launchctl", args: ["bootout", `gui/${options.uid}/${label}`] }] };
  }
  const task = "VibeStick Host";
  const run = windowsQuote([options.executable, ...args]);
  return { files: [], install: [{ command: "schtasks", args: ["/Create", "/TN", task, "/SC", "ONLOGON", "/TR", run, "/F"] }], uninstall: [{ command: "schtasks", args: ["/Delete", "/TN", task, "/F"] }] };
}

function systemdEscape(value: string): string { return value.replace(/([\\\s"'])/g, "\\$1"); }
function xml(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function plist(label: string, executable: string, args: string[]): string {
  const array = [executable, ...args].map((item) => `    <string>${xml(item)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>${xml(label)}</string>\n  <key>ProgramArguments</key><array>\n${array}\n  </array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><false/>\n</dict></plist>\n`;
}
function windowsQuote(items: string[]): string { return items.map((item) => `"${item.replace(/"/g, '\\"')}"`).join(" "); }
