export interface SessionStatus { tool: string; model: string; session: string; state: string; ctx_pct: number; cost_usd: number; last: string; updated: number; tail?: string[]; queued?: number; }
export interface SessionInfo { id: string; tool: string; name: string; state: string; fg: boolean; }
export interface SessionsPayload { active: number; list: SessionInfo[]; }

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
  return { active: payload.active, list: payload.list.map((session) => ({ ...session })) };
}
