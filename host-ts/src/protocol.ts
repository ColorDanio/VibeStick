export interface SessionStatus { tool: string; model: string; session: string; state: string; ctx_pct: number; cost_usd: number; last: string; updated: number; tail?: string[]; queued?: number; }
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
  hidInput: "00002a4d-0000-1000-8000-00805f9b34fb",
} as const;

export function statusToWire(status: SessionStatus): SessionStatus {
  const output: SessionStatus = { tool: status.tool, model: status.model, session: status.session, state: status.state, ctx_pct: status.ctx_pct, cost_usd: status.cost_usd, last: status.last, updated: status.updated };
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

function truncate(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join("");
}
