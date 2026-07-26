/** OS registration plans. Execution is delegated to an elevated installer. */
export type HostPlatform = "linux" | "darwin" | "win32";
export interface LifecycleOptions {
  executable: string;
  configPath: string;
  home: string;
  uid: number;
  /** Overrides the legacy `--config <path>` argument form for packaged hosts. */
  arguments?: string[];
  /** Runtime variables required by a packaged launcher (never persisted as secrets). */
  environment?: Record<string, string>;
}
export interface ManagedFile { path: string; contents: string; }
export interface Invocation { command: string; args: string[]; }
export interface LifecyclePlan { files: ManagedFile[]; install: Invocation[]; uninstall: Invocation[]; }

const serviceName = "vibestick-ts";

/**
 * Produce idempotent per-user registration instructions.  The Electron
 * installer or CLI runner executes this plan; domain code never shells out.
 */
export function lifecyclePlan(platform: HostPlatform, options: LifecycleOptions): LifecyclePlan {
  const args = options.arguments ?? ["--config", options.configPath];
  const environment = Object.entries(options.environment ?? {}).filter(([key, value]) => key && !/[=\0\r\n]/.test(key) && !/[\0\r\n]/.test(value));
  if (platform === "linux") {
    const path = `${options.home}/.config/systemd/user/${serviceName}.service`;
    const variables = environment.map(([key, value]) => `Environment="${systemdEscape(`${key}=${value}`)}"\n`).join("");
    const contents = `[Unit]\nDescription=VibeStick TypeScript Host\nAfter=graphical-session.target\n\n[Service]\nType=simple\n${variables}ExecStart=${[options.executable, ...args].map(systemdEscape).join(" ")}\nRestart=on-failure\nRestartSec=3\n\n[Install]\nWantedBy=default.target\n`;
    return { files: [{ path, contents }], install: [{ command: "systemctl", args: ["--user", "daemon-reload"] }, { command: "systemctl", args: ["--user", "enable", "--now", `${serviceName}.service`] }], uninstall: [{ command: "systemctl", args: ["--user", "disable", "--now", `${serviceName}.service`] }] };
  }
  if (platform === "darwin") {
    const label = "io.vibestick.host";
    const path = `${options.home}/Library/LaunchAgents/${label}.plist`;
    const contents = plist(label, options.executable, args, environment);
    return { files: [{ path, contents }], install: [{ command: "launchctl", args: ["bootstrap", `gui/${options.uid}`, path] }], uninstall: [{ command: "launchctl", args: ["bootout", `gui/${options.uid}/${label}`] }] };
  }
  const task = "VibeStick Host";
  if (!environment.length) {
    const run = windowsQuote([options.executable, ...args]);
    return { files: [], install: [{ command: "schtasks", args: ["/Create", "/TN", task, "/SC", "ONLOGON", "/TR", run, "/F"] }], uninstall: [{ command: "schtasks", args: ["/Delete", "/TN", task, "/F"] }] };
  }
  const path = `${options.home}/AppData/Local/VibeStick/${serviceName}.cmd`;
  const contents = `@echo off\r\n${environment.map(([key, value]) => `set "${key}=${value.replace(/"/g, "\\\"")}"\r\n`).join("")}${windowsQuote([options.executable, ...args])}\r\n`;
  const run = windowsQuote(["cmd.exe", "/d", "/s", "/c", path]);
  return { files: [{ path, contents }], install: [{ command: "schtasks", args: ["/Create", "/TN", task, "/SC", "ONLOGON", "/TR", run, "/F"] }], uninstall: [{ command: "schtasks", args: ["/Delete", "/TN", task, "/F"] }] };
}

function systemdEscape(value: string): string { return value.replace(/([\\\s"'])/g, "\\$1"); }
function xml(value: string): string { return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function plist(label: string, executable: string, args: string[], environment: [string, string][]): string {
  const array = [executable, ...args].map((item) => `    <string>${xml(item)}</string>`).join("\n");
  const variables = environment.length ? `\n  <key>EnvironmentVariables</key><dict>${environment.map(([key, value]) => `\n    <key>${xml(key)}</key><string>${xml(value)}</string>`).join("")}\n  </dict>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>${xml(label)}</string>\n  <key>ProgramArguments</key><array>\n${array}\n  </array>${variables}\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><false/>\n</dict></plist>\n`;
}
function windowsQuote(items: string[]): string { return items.map((item) => `"${item.replace(/"/g, '\\"')}"`).join(" "); }
