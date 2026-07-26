import { createServer, type Server } from "node:http";
import type { HostCore } from "./core.js";
import { dashboardRequest, type DashboardEnvironment } from "./dashboard.js";

export interface SettingsService {
  updateOnlineAsr(body: unknown): Promise<{ engine: string; api_base: string; model: string; configured: boolean }>;
  updateSessionLauncher(body: unknown): Promise<{ session_launcher: "auto" | "tmux" | "zellij" }>;
  updateToolCwd(body: unknown): Promise<{ id: string; cwd: string }>;
}

export type DiagnosticsService = () => Record<string, unknown>;

export interface DashboardServer { readonly port: number; close(): Promise<void>; }

/** Minimal loopback-only HTTP adapter; Electron or a browser may consume it. */
export async function startDashboardServer(core: HostCore, port = 7861, environment?: () => DashboardEnvironment, settings?: SettingsService, diagnostics?: DiagnosticsService): Promise<DashboardServer> {
  const server = createServer(async (request, response) => {
    const origin = request.headers.origin;
    if (origin === "http://127.0.0.1:5174" || origin === "http://localhost:5174" || origin === "null") {
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      response.setHeader("access-control-allow-headers", "content-type");
      response.setHeader("vary", "Origin");
    }
    if (request.method === "OPTIONS") { response.writeHead(204).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
      if (Buffer.concat(chunks).length > 64 * 1024) { response.writeHead(413).end(); return; }
    }
    let body: unknown;
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined; }
    catch { response.writeHead(400, { "content-type": "application/json" }).end('{"error":"invalid json"}'); return; }
    if (request.method === "GET" && request.url === "/api/diagnostics" && diagnostics) {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-disposition": "attachment; filename=vibestick-diagnostics.json" });
      response.end(JSON.stringify(diagnostics(), null, 2)); return;
    }
    if (request.method === "POST" && request.url === "/api/settings/asr" && settings) {
      try {
        const result = await settings.updateOnlineAsr(body);
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ ok: true, restart_required: true, asr: result })); return;
      } catch (error) {
        response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); return;
      }
    }
    if (request.method === "POST" && request.url === "/api/settings/session-launcher" && settings) {
      try {
        const result = await settings.updateSessionLauncher(body);
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ ok: true, restart_required: true, ...result })); return;
      } catch (error) {
        response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); return;
      }
    }
    if (request.method === "POST" && request.url === "/api/settings/tool-cwd" && settings) {
      try {
        const result = await settings.updateToolCwd(body);
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ ok: true, restart_required: true, ...result })); return;
      } catch (error) {
        response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); return;
      }
    }
    const result = dashboardRequest(core, request.method ?? "GET", request.url ?? "/", body, environment?.());
    response.writeHead(result.status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify(result.body));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolve()); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("dashboard did not bind TCP");
  return { port: address.port, close: () => close(server) };
}

function close(server: Server): Promise<void> { return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
