import { spawn } from "node:child_process";
import { basename } from "node:path";
import type { Config } from "./config.js";
import type { SessionRecord } from "./store.js";

export interface ProcessInfo { pid: number; name: string; tty?: string; }
export interface ProcessInspector { list(): Promise<ProcessInfo[]>; }

/** Best-effort, no-shell process inspector. Platform failures degrade discovery only. */
export class NodeProcessInspector implements ProcessInspector {
  constructor(private readonly platform = process.platform) {}
  async list(): Promise<ProcessInfo[]> {
    if (this.platform === "win32") return parseWindows(await exec("powershell", ["-NoProfile", "-Command", "Get-Process | Select-Object Id,ProcessName | ConvertTo-Json -Compress"]));
    if (this.platform === "linux" || this.platform === "darwin") return parsePs(await exec("ps", ["-eo", "pid=,comm=,tty="]));
    return [];
  }
}

/** Derive non-authoritative live sessions; adapter-file sessions always remain canonical. */
export function discoverProcessSessions(config: Config, processes: ProcessInfo[], now = Math.floor(Date.now() / 1000)): SessionRecord[] {
  const records: SessionRecord[] = [];
  for (const tool of config.tools) {
    if (tool.hidden || tool.discover === false) continue;
    const names = new Set([tool.process, ...(tool.aliases ?? [])].filter((name): name is string => Boolean(name)).map(normalize));
    for (const process of processes) {
      if (!names.has(normalize(process.name))) continue;
      records.push({
        id: `process-${tool.id}-${process.pid}`,
        status: { tool: tool.id, model: "", session: `${tool.name} · ${process.pid}`, state: "idle", ctx_pct: -1, cost_usd: -1, last: "Live process", updated: now },
        fg: true, raw: { pid: process.pid, ...(process.tty && process.tty !== "?" ? { tty: `/dev/${process.tty.replace(/^\//, "")}` } : {}) },
      });
    }
  }
  return records;
}

/** Do not duplicate a process already represented by an adapter or wrapper state file. */
export function mergeSessions(files: SessionRecord[], live: SessionRecord[]): SessionRecord[] {
  const filePids = new Set(files.map((record) => Number(record.raw?.pid)).filter((pid) => Number.isInteger(pid) && pid > 0));
  return [...files, ...live.filter((record) => !filePids.has(Number(record.raw?.pid)))];
}

function normalize(value: string): string { return basename(value).replace(/\.exe$/i, "").toLowerCase(); }
function exec(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true }); let output = "";
    child.stdout.on("data", (data) => { output += String(data); }); child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(output) : reject(new Error(`${command} exited ${code}`)));
  });
}
function parsePs(output: string): ProcessInfo[] {
  return output.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+(\S+)$/);
    return match ? [{ pid: Number(match[1]), name: match[2] ?? "", ...(match[3] ? { tty: match[3] } : {}) }] : [];
  });
}
function parseWindows(output: string): ProcessInfo[] {
  try {
    const raw: unknown = JSON.parse(output); const entries = Array.isArray(raw) ? raw : [raw];
    return entries.flatMap((item) => typeof item === "object" && item !== null && typeof (item as { Id?: unknown }).Id === "number" && typeof (item as { ProcessName?: unknown }).ProcessName === "string"
      ? [{ pid: (item as { Id: number }).Id, name: (item as { ProcessName: string }).ProcessName }] : []);
  } catch { return []; }
}
