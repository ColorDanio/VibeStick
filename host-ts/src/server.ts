import { createServer, type Server } from "node:http";
import type { HostCore } from "./core.js";
import { dashboardRequest, type DashboardEnvironment } from "./dashboard.js";

export interface SettingsService {
  updateOnlineAsr(body: unknown): Promise<{ engine: string; api_base: string; model: string; configured: boolean }>;
  startLocalAsrDownload?(body: unknown): Promise<LocalAsrModelStatus>;
  localAsrDownloadStatus?(): LocalAsrModelStatus;
  applyLocalAsr?(body: unknown): Promise<{ engine: string; api_base: string; model: string; configured: boolean }>;
  testOnlineAsr(): Promise<{ provider: "reachable"; model_available: boolean | null }>;
  testYoloFocused(): Promise<{ available: boolean; detail: string }>;
  updateSessionLauncher(body: unknown): Promise<{ session_launcher: "auto" | "tmux" | "zellij" }>;
  updateToolCwd(body: unknown): Promise<{ id: string; cwd: string }>;
  updateMicBindings?(body: unknown): Promise<{ button_a: string; button_b: string }>;
  scanSticks?(): Promise<{ name: string; address: string; rssi?: number | null; paired?: boolean; connected?: boolean }[]>;
  pairedSticks?(): Promise<{ name: string; address: string; rssi?: number | null; paired?: boolean; connected?: boolean }[]>;
  connectStick?(body: unknown): Promise<{ name?: string; address: string }>;
  pairStick?(body: unknown): Promise<void>;
  unpairStick?(body: unknown): Promise<void>;
}

export type LocalAsrModelStatus = { model: string; state: "idle" | "downloading" | "ready" | "applying" | "applied" | "error"; progress: number; detail?: string };

export type DiagnosticsService = () => Record<string, unknown>;

export interface DashboardServer { readonly port: number; close(): Promise<void>; }

const desktopOrigins = new Set([
  "http://127.0.0.1:5174",
  "http://localhost:5174",
  // Tauri's Linux/WebKit custom protocol is exposed as an HTTP localhost origin;
  // other targets may retain the tauri scheme. Both are app-local renderers.
  "http://tauri.localhost",
  "tauri://localhost",
  "null",
]);

/** Minimal loopback-only HTTP adapter; Electron or a browser may consume it. */
export async function startDashboardServer(core: HostCore, port = 7861, environment?: () => DashboardEnvironment, settings?: SettingsService, diagnostics?: DiagnosticsService): Promise<DashboardServer> {
  const server = createServer(async (request, response) => {
    const origin = request.headers.origin;
    if (origin && desktopOrigins.has(origin)) {
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
    if (request.method === "POST" && request.url === "/api/settings/asr/local/download" && settings?.startLocalAsrDownload) {
      try {
        const result = await settings.startLocalAsrDownload(body);
        response.writeHead(202, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ ok: true, ...result })); return;
      } catch (error) {
        response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); return;
      }
    }
    if (request.method === "GET" && request.url === "/api/settings/asr/local/download" && settings?.localAsrDownloadStatus) {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      response.end(JSON.stringify({ ok: true, ...settings.localAsrDownloadStatus() })); return;
    }
    if (request.method === "POST" && request.url === "/api/settings/asr/local/apply" && settings?.applyLocalAsr) {
      try {
        const result = await settings.applyLocalAsr(body);
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ ok: true, restart_required: true, asr: result })); return;
      } catch (error) {
        response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); return;
      }
    }
    if (request.method === "POST" && request.url === "/api/settings/asr/test" && settings) {
      try {
        const result = await settings.testOnlineAsr();
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ ok: true, ...result })); return;
      } catch (error) {
        response.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); return;
      }
    }
    if (request.method === "POST" && request.url === "/api/settings/yolo/test" && settings) {
      try {
        const result = await settings.testYoloFocused();
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ ok: true, ...result })); return;
      } catch (error) {
        response.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
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
    if (request.method === "POST" && request.url === "/api/settings/mic-bindings" && settings?.updateMicBindings) {
      try {
        const result = await settings.updateMicBindings(body);
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify({ ok: true, restart_required: true, ...result })); return;
      } catch (error) {
        response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); return;
      }
    }
    if (request.method === "POST" && request.url === "/api/devices/scan" && settings?.scanSticks) {
      try { response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(JSON.stringify({ ok: true, devices: await settings.scanSticks() })); return; }
      catch (error) { response.writeHead(400, { "content-type": "application/json; charset=utf-8" }); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); return; }
    }
    if (request.method === "GET" && request.url === "/api/devices/paired" && settings?.pairedSticks) {
      try { response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(JSON.stringify({ ok: true, devices: await settings.pairedSticks() })); return; }
      catch (error) { response.writeHead(400, { "content-type": "application/json; charset=utf-8" }); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); return; }
    }
    if (request.method === "POST" && request.url === "/api/devices/connect" && settings?.connectStick) {
      try { response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(JSON.stringify({ ok: true, device: await settings.connectStick(body) })); return; }
      catch (error) { response.writeHead(400, { "content-type": "application/json; charset=utf-8" }); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); return; }
    }
    if (request.method === "POST" && request.url === "/api/devices/pair" && settings?.pairStick) {
      try { await settings.pairStick(body); response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}'); return; }
      catch (error) { response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); return; }
    }
    if (request.method === "POST" && request.url === "/api/devices/unpair" && settings?.unpairStick) {
      try { await settings.unpairStick(body); response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}'); return; }
      catch (error) { response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); return; }
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
