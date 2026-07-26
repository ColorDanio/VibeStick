import type { HostCore } from "./core.js";
import type { Capabilities, RuntimeState } from "./runtime.js";

export interface DashboardResponse { status: number; body: object; }
export interface DashboardEnvironment {
  implementation: "host-2";
  owner: "active" | "inactive";
  runtime: RuntimeState;
  capabilities: Capabilities;
  config: { path: string; asr_engine: string; asr_api_base: string; asr_model: string; online_asr_configured: boolean; session_launcher: "auto" | "tmux" | "zellij"; tools: { id: string; name: string; cwd: string }[] };
  error?: string;
}

const unavailable: Capabilities = {
  ble: { available: false, reason: "Host 2.0 is not connected" },
  keyboard: { available: false, reason: "Host 2.0 is not connected" },
  mic: { available: false, reason: "Host 2.0 is not connected" },
  asr: { available: false, reason: "Host 2.0 is not connected" },
};

/** HTTP/IPC contract; a Node HTTP server or Electron IPC adapter can call this. */
export function dashboardRequest(core: HostCore, method: string, path: string, body?: unknown, environment?: DashboardEnvironment): DashboardResponse {
  if (method === "GET" && path === "/api/status") return { status: 200, body: core.snapshot() };
  if (method === "GET" && path === "/api/desktop") {
    return { status: 200, body: { ...core.snapshot(), environment: environment ?? {
      implementation: "host-2", owner: "inactive", runtime: "stopped", capabilities: unavailable,
      config: { path: "", asr_engine: "", asr_api_base: "", asr_model: "", online_asr_configured: false, session_launcher: "auto", tools: [] },
    } } };
  }
  if (method === "POST" && path === "/api/command" && isRecord(body) && typeof body.cmd === "string") {
    const command: { cmd: string; id?: string; mode?: unknown } = { cmd: body.cmd };
    if (typeof body.id === "string") command.id = body.id;
    if ("mode" in body) command.mode = body.mode;
    const result = core.command(command);
    return { status: result.changed ? 200 : 400, body: { ok: result.changed, actions: result.actions, ...core.snapshot() } };
  }
  return { status: 404, body: { error: "not found" } };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
