import type { Config, ToolConfig } from "./config.js";
import type { SessionInfo, SessionStatus, SessionsPayload } from "./protocol.js";
import { SessionSelection } from "./session.js";

export interface SessionRecord { id: string; status: SessionStatus; fg?: boolean; raw?: Record<string, unknown>; }
export interface ToolInfo { id: string; name: string; state: string; fns: string[]; }
export interface ToolsPayload { active: number; list: ToolInfo[]; }

const priority = ["running", "waiting", "error", "idle"];
const rank = (state: string): number => {
  const value = priority.indexOf(state);
  return value === -1 ? priority.indexOf("idle") : value;
};

/**
 * Domain-only session store. Persistence/discovery and BLE belong to adapters;
 * this model owns exactly the selection and payload rules both hosts share.
 */
export class HostSessionStore {
  private records: SessionRecord[] = [];
  private selection: SessionSelection;
  private pendingNew: { tool: string; known: Set<string>; deadline: number } | undefined;

  constructor(readonly config: Config) {
    this.selection = new SessionSelection(config.tools, []);
  }

  replace(records: SessionRecord[]): void {
    const priorTool = this.selection.selectedTool;
    const priorActive = this.selection.activeId;
    this.records = [...records].sort((a, b) => b.status.updated - a.status.updated);
    this.selection = new SessionSelection(
      this.config.tools,
      this.records.map((record) => ({ id: record.id, tool: record.status.tool, state: record.status.state })),
      priorTool,
    );
    if (priorActive && this.selection.ids().includes(priorActive)) this.selection.apply({ cmd: "session.select", id: priorActive });
    if (this.pendingNew && this.pendingNew.tool === this.selection.selectedTool && Date.now() <= this.pendingNew.deadline) {
      const fresh = this.selection.ids().find((id) => !this.pendingNew?.known.has(id));
      if (fresh) { this.selection.apply({ cmd: "session.select", id: fresh }); this.pendingNew = undefined; }
    } else if (this.pendingNew && Date.now() > this.pendingNew.deadline) this.pendingNew = undefined;
  }

  apply(command: { cmd: string; id?: string }): boolean { return this.selection.apply(command); }
  get selectedTool(): string | null { return this.selection.selectedTool; }
  get activeId(): string | null { return this.selection.activeId; }
  activeRaw(): Record<string, unknown> | undefined { return this.records.find((record) => record.id === this.activeId)?.raw; }
  requestNewSession(now = Date.now(), timeoutMs = 30_000): void {
    this.pendingNew = { tool: this.selectedTool ?? "", known: new Set(this.selection.ids()), deadline: now + timeoutMs };
  }

  statusPayload(): SessionStatus {
    return this.records.find((record) => record.id === this.activeId)?.status
      ?? { tool: this.selectedTool ?? "", model: "", session: "", state: "idle", ctx_pct: -1, cost_usd: -1, last: "", updated: 0 };
  }

  sessionsPayload(): SessionsPayload {
    const ids = this.selection.ids();
    const active = Math.max(0, ids.indexOf(this.activeId ?? ""));
    const list: SessionInfo[] = ids.flatMap((id) => {
      const record = this.records.find((item) => item.id === id);
      return record ? [{ id: record.id, tool: record.status.tool, name: record.status.session || record.id, state: record.status.state, fg: record.fg === true }] : [];
    });
    return { active, list };
  }

  toolsPayload(): ToolsPayload {
    const visible = this.config.tools.filter((tool) => !tool.hidden);
    const list = visible.map((tool) => this.toolInfo(tool));
    return { active: Math.max(0, visible.findIndex((tool) => tool.id === this.selectedTool)), list };
  }

  private toolInfo(tool: ToolConfig): ToolInfo {
    const sessions = this.records.filter((record) => record.status.tool === tool.id);
    let state = sessions.reduce((best, record) => rank(record.status.state) < rank(best) ? record.status.state : best, "idle");
    if (state === "idle" && sessions.length) state = "ready";
    const fns = ["status", "sessions"];
    if (this.config.features.voice_enabled) fns.push("voice");
    fns.push(...Object.keys(tool.bindings).filter((key) => key !== "cancel").sort());
    return { id: tool.id, name: tool.name, state, fns };
  }
}
