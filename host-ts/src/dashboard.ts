import type { HostCore } from "./core.js";

export interface DashboardResponse { status: number; body: object; }

/** HTTP/IPC contract; a Node HTTP server or Electron IPC adapter can call this. */
export function dashboardRequest(core: HostCore, method: string, path: string, body?: unknown): DashboardResponse {
  if (method === "GET" && path === "/api/status") return { status: 200, body: core.snapshot() };
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
