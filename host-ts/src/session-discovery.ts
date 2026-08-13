import { spawn } from "node:child_process";
import type { Config } from "./config.js";
import { configToWire } from "./config.js";
import type { SessionRecord } from "./store.js";

export interface PythonDiscoveryRequest { executable: string; helper: string; config: Config; }
export type PythonDiscoveryRunner = (request: PythonDiscoveryRequest) => Promise<SessionRecord[]>;

/**
 * Read Linux CLI stores through the already-supported Python compatibility
 * runtime. HostCore still owns all session selection and BLE publication;
 * this process only supplies read-only discovery records and safe terminal
 * metadata that Node cannot obtain reliably from every terminal multiplexer.
 */
export function pythonSessionDiscovery(executable: string, helper: string, config: Config, runner: PythonDiscoveryRunner = runPythonSessionDiscovery): Promise<SessionRecord[]> {
  return runner({ executable, helper, config });
}

function runPythonSessionDiscovery(request: PythonDiscoveryRequest): Promise<SessionRecord[]> {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(request.executable, [request.helper], { stdio: "pipe", windowsHide: true }); }
    catch (error) { reject(error instanceof Error ? error : new Error(String(error))); return; }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("session discovery timed out")); }, 10_000);
    child.stdout.on("data", (data) => { stdout += String(data); });
    child.stderr.on("data", (data) => { stderr = (stderr + String(data)).slice(-300); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      try {
        const result: unknown = JSON.parse(stdout);
        if (isResult(result) && result.ok === true && Array.isArray(result.records)) { resolve(result.records.flatMap(record)); return; }
        reject(new Error(isResult(result) && typeof result.error === "string" ? result.error : stderr || `session discovery exited ${code ?? "unknown"}`));
      } catch { reject(new Error(stderr || `session discovery exited ${code ?? "unknown"}`)); }
    });
    child.stdin.end(`${JSON.stringify({ config: configToWire(request.config) })}\n`);
  });
}

type Result = { ok?: unknown; records?: unknown; error?: unknown };
type ObjectValue = Record<string, unknown>;
function isResult(value: unknown): value is Result { return typeof value === "object" && value !== null; }
function isObject(value: unknown): value is ObjectValue { return typeof value === "object" && value !== null && !Array.isArray(value); }
function record(value: unknown): SessionRecord[] {
  if (!isObject(value) || typeof value.id !== "string" || !isObject(value.status)) return [];
  const status = value.status;
  const required = ["tool", "model", "session", "state", "ctx_pct", "cost_usd", "last", "updated"];
  if (!required.every((key) => key in status)) return [];
  return [{
    id: value.id,
    status: {
      tool: string(status.tool), model: string(status.model), session: string(status.session), state: string(status.state),
      ctx_pct: number(status.ctx_pct, -1), cost_usd: number(status.cost_usd, -1), last: string(status.last), updated: number(status.updated, 0),
      ...(Array.isArray(status.tail) ? { tail: status.tail.map(String) } : {}),
      ...(typeof status.queued === "number" && status.queued ? { queued: status.queued } : {}),
      ...(typeof status.quota_pct === "number" && Number.isFinite(status.quota_pct) && status.quota_pct >= 0 ? { quota_pct: status.quota_pct } : {}),
      ...(typeof status.tokens === "number" && Number.isFinite(status.tokens) && status.tokens >= 0 ? { tokens: status.tokens } : {}),
    },
    ...(value.fg === true ? { fg: true } : {}),
    ...(isObject(value.raw) ? { raw: value.raw } : {}),
  }];
}
function string(value: unknown): string { return typeof value === "string" ? value : ""; }
function number(value: unknown, fallback: number): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
