import { chmod, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { configToWire, normalizeConfig, type Config } from "./config.js";
import type { SessionRecord } from "./store.js";
import type { SessionStatus } from "./protocol.js";

/** Read an existing config; callers decide whether a missing file should create defaults. */
export async function loadConfigFile(path: string): Promise<Config> {
  return normalizeConfig(JSON.parse(await readFile(path, "utf8")) as unknown);
}

/** Atomic, owner-only config persistence; matches the Python daemon's safety rule. */
export async function saveConfigFile(path: string, config: Config): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(configToWire(config), null, 2)}\n`, "utf8");
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

/**
 * Adapter-session file repository. Discovery databases and live processes are
 * separate adapters; this is the portable persisted baseline shared by hosts.
 */
export async function loadSessionDirectory(directory: string, now = Date.now()): Promise<SessionRecord[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (isCode(error, "ENOENT")) return [];
    throw error;
  });
  const records: SessionRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(directory, entry.name);
    try {
      const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      if (!string(raw.tool)) continue;
      const info = await stat(path);
      const status = statusFromFile(raw, Math.floor(info.mtimeMs / 1000));
      // Keep the existing 30-minute expiry behaviour, based on protocol time.
      if (now / 1000 - status.updated > 30 * 60) continue;
      records.push({ id: string(raw.id) || entry.name.slice(0, -5), status });
    } catch {
      // One malformed adapter file must not take down the host.
    }
  }
  return records.sort((left, right) => right.status.updated - left.status.updated);
}

function statusFromFile(raw: Record<string, unknown>, mtime: number): SessionStatus {
  const tail = Array.isArray(raw.tail) ? raw.tail.map(String) : undefined;
  const queued = number(raw.queued, 0);
  const status: SessionStatus = {
    tool: string(raw.tool), model: string(raw.model), session: string(raw.session), state: string(raw.state, "idle"),
    ctx_pct: number(raw.ctx_pct, -1), cost_usd: number(raw.cost_usd, -1), last: string(raw.last), updated: number(raw.updated, 0) || mtime,
  };
  if (tail?.length) status.tail = tail;
  if (queued) status.queued = queued;
  return status;
}

const string = (value: unknown, fallback = ""): string => typeof value === "string" ? value : fallback;
const number = (value: unknown, fallback: number): number => typeof value === "number" && Number.isFinite(value) ? value : fallback;
const isCode = (error: unknown, code: string): boolean => typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
