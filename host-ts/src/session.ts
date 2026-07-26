/** Side-effect-free selection model for the tool carousel and session list. */
export interface Tool { id: string; hidden?: boolean; }
export interface Session { id: string; tool: string; state: string; }

export class SessionSelection {
  readonly tools: Tool[];
  readonly sessions: Session[];
  selectedTool: string | null;
  activeId: string | null;

  constructor(tools: Tool[], sessions: Session[], selectedTool?: string | null) {
    this.tools = tools.filter((tool) => !tool.hidden);
    this.sessions = sessions;
    this.selectedTool = this.tools.some((tool) => tool.id === selectedTool)
      ? selectedTool ?? null : this.tools[0]?.id ?? null;
    this.activeId = this.ids()[0] ?? null;
  }

  ids(): string[] { return this.sessions.filter((session) => session.tool === this.selectedTool).map((session) => session.id); }
  active(): Session | undefined { return this.sessions.find((session) => session.id === this.activeId); }

  apply(command: { cmd: string; id?: string }): boolean {
    if (command.cmd === "tool.next") return this.selectToolDelta(1);
    if (command.cmd === "tool.select") return this.selectTool(command.id ?? "");
    const ids = this.ids();
    if (!ids.length) return false;
    const current = Math.max(0, ids.indexOf(this.activeId ?? ""));
    if (command.cmd === "session.next") this.activeId = ids[(current + 1) % ids.length] ?? null;
    else if (command.cmd === "session.prev") this.activeId = ids[(current - 1 + ids.length) % ids.length] ?? null;
    else if (command.cmd === "session.select") {
      const exact = command.id ?? "";
      const matches = ids.filter((id) => id === exact || id.startsWith(exact));
      if (matches.length !== 1) return false;
      this.activeId = matches[0] ?? null;
    } else return false;
    return true;
  }

  private selectToolDelta(delta: number): boolean {
    if (!this.tools.length) return false;
    const current = Math.max(0, this.tools.findIndex((tool) => tool.id === this.selectedTool));
    return this.selectTool(this.tools[(current + delta + this.tools.length) % this.tools.length]?.id ?? "");
  }

  private selectTool(id: string): boolean {
    if (!this.tools.some((tool) => tool.id === id)) return false;
    if (id === this.selectedTool && this.activeId === (this.ids()[0] ?? null)) return false;
    this.selectedTool = id;
    this.activeId = this.ids()[0] ?? null;
    return true;
  }
}
