import type { HostPlatform, LifecyclePlan } from "./lifecycle.js";
import { lifecyclePlan } from "./lifecycle.js";

export interface DesktopLifecycleOptions {
  platform: HostPlatform;
  executable: string;
  appArguments: string[];
  home: string;
  uid: number;
  environment?: NodeJS.ProcessEnv;
}

/** A per-user login plan for the Electron shell that owns its HostCore child. */
export function desktopLifecyclePlan(options: DesktopLifecycleOptions): LifecyclePlan {
  return lifecyclePlan(options.platform, {
    executable: options.executable,
    configPath: "",
    arguments: options.appArguments,
    home: options.home,
    uid: options.uid,
    environment: desktopEnvironment(options.platform, options.environment),
  });
}

/**
 * Preserve the graphical session plus the non-secret Linux compatibility
 * runtime chosen when the user enabled login startup. Without these paths a
 * VibeConn 2.0 app launched by systemd would silently lose its verified
 * Python BLE/audio/session adapters after the next login.
 */
export function desktopEnvironment(platform: HostPlatform, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (platform !== "linux") return {};
  const names = [
    "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS",
    "VIBESTICK_LINUX_HELPER", "VIBECONN_PYTHON", "VIBECONN_LINUX_BACKEND",
  ];
  return Object.fromEntries(names.flatMap((name) => typeof source[name] === "string" && source[name] ? [[name, source[name]]] : []));
}
