export interface SessionStatus { tool: string; model: string; session: string; state: string; ctx_pct: number; cost_usd: number; last: string; updated: number; tail?: string[]; queued?: number; }
export interface SessionInfo { id: string; tool: string; name: string; state: string; fg: boolean; }
export interface SessionsPayload { active: number; list: SessionInfo[]; }

export function statusToWire(status: SessionStatus): SessionStatus {
  const output: SessionStatus = { tool: status.tool, model: status.model, session: status.session, state: status.state, ctx_pct: status.ctx_pct, cost_usd: status.cost_usd, last: status.last, updated: status.updated };
  if (status.tail?.length) output.tail = [...status.tail];
  if (status.queued) output.queued = status.queued;
  return output;
}

export function sessionsToWire(payload: SessionsPayload): SessionsPayload {
  return { active: payload.active, list: payload.list.map((session) => ({ ...session })) };
}
