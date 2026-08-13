export interface SessionStatus {
  tool: string;
  model: string;
  session: string;
  state: string;
  ctx_pct: number;
  cost_usd: number;
  /** Optional provider quota percentage observed in a local CLI log. */
  quota_pct?: number;
  /** Optional cumulative token count observed in a local CLI log. */
  tokens?: number;
  last: string;
  updated: number;
  tail?: string[];
  queued?: number;
}
export interface SessionInfo { id: string; tool: string; name: string; state: string; fg: boolean; }
export interface SessionsPayload { active: number; list: SessionInfo[]; }

/**
 * The firmware receives each GATT value as one JSON document.  BlueZ's
 * long-write path is not reliable for this characteristic, so keep the
 * device-facing document within the protocol's single-write budget.
 */
export const BLE_PAYLOAD_MAX_BYTES = 512;

export const BLE = {
  service: "4b1e0001-5a3f-4c8d-9b6e-7f2a1c0d3e5f",
  status: "4b1e0002-5a3f-4c8d-9b6e-7f2a1c0d3e5f",
  sessions: "4b1e0003-5a3f-4c8d-9b6e-7f2a1c0d3e5f",
  input: "4b1e0004-5a3f-4c8d-9b6e-7f2a1c0d3e5f",
  command: "4b1e0005-5a3f-4c8d-9b6e-7f2a1c0d3e5f",
  tools: "4b1e0006-5a3f-4c8d-9b6e-7f2a1c0d3e5f",
  voice: "4b1e0007-5a3f-4c8d-9b6e-7f2a1c0d3e5f",
  audio: "4b1e0008-5a3f-4c8d-9b6e-7f2a1c0d3e5f",
  deviceConfig: "4b1e0009-5a3f-4c8d-9b6e-7f2a1c0d3e5f",
  /** Optional v2.4 local CLI usage summary (daemon -> device). */
  usage: "4b1e000a-5a3f-4c8d-9b6e-7f2a1c0d3e5f",
  hidInput: "00002a4d-0000-1000-8000-00805f9b34fb",
} as const;

export function statusToWire(status: SessionStatus): SessionStatus {
  const output: SessionStatus = { tool: status.tool, model: status.model, session: status.session, state: status.state, ctx_pct: status.ctx_pct, cost_usd: status.cost_usd, last: status.last, updated: status.updated };
  if (typeof status.quota_pct === "number" && Number.isFinite(status.quota_pct) && status.quota_pct >= 0) output.quota_pct = status.quota_pct;
  if (typeof status.tokens === "number" && Number.isFinite(status.tokens) && status.tokens >= 0) output.tokens = status.tokens;
  if (status.tail?.length) output.tail = [...status.tail];
  if (status.queued) output.queued = status.queued;
  return output;
}

export function sessionsToWire(payload: SessionsPayload): SessionsPayload {
  const entries = payload.list.map((session) => ({ ...session, name: truncate(session.name, 40) }));
  let active = Math.max(0, Math.min(payload.active, Math.max(0, entries.length - 1)));
  const encodedLength = (): number => new TextEncoder().encode(JSON.stringify({ active, list: entries })).length;

  // Preserve the selected session while dropping the least useful tail
  // entries. This mirrors the 1.x protocol contract and avoids disconnect
  // loops when a CLI has many discovered sessions.
  while (encodedLength() > BLE_PAYLOAD_MAX_BYTES && entries.length > 1) {
    let index = entries.length - 1;
    if (index === active) index -= 1;
    if (index < 0) break;
    entries.splice(index, 1);
    if (active > index) active -= 1;
  }
  return { active, list: entries };
}

/** Keep optional usage snapshots within the same single-write BLE budget. */
export function usageToWire<T extends { updated: number; interval_s: 30; list: Array<{ tool: string; name: string; sessions: number; active: number; ctx_pct?: number; cost_usd?: number; quota_pct?: number; tokens?: number; updated: number }> }>(payload: T): T {
  const list = payload.list.map((entry) => ({ ...entry, tool: truncate(entry.tool, 16), name: truncate(entry.name, 24) }));
  const encodedLength = (): number => new TextEncoder().encode(JSON.stringify({ updated: payload.updated, interval_s: 30, list })).length;
  while (encodedLength() > BLE_PAYLOAD_MAX_BYTES && list.length > 1) list.pop();
  return { ...payload, interval_s: 30, list };
}

function truncate(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join("");
}
