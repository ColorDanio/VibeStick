import { createServer, type Server } from "node:http";
import type { HostCore } from "./core.js";
import { dashboardRequest, type DashboardEnvironment } from "./dashboard.js";

export interface DashboardServer { readonly port: number; close(): Promise<void>; }

/** Minimal loopback-only HTTP adapter; Electron or a browser may consume it. */
export async function startDashboardServer(core: HostCore, port = 7861, environment?: () => DashboardEnvironment): Promise<DashboardServer> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
      if (Buffer.concat(chunks).length > 64 * 1024) { response.writeHead(413).end(); return; }
    }
    let body: unknown;
    try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined; }
    catch { response.writeHead(400, { "content-type": "application/json" }).end('{"error":"invalid json"}'); return; }
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
