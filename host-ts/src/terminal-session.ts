import { spawn } from "node:child_process";
import type { HostCore } from "./core.js";

export interface TerminalInvocation { command: string; args: string[]; }
export type TerminalRunner = (input: TerminalInvocation) => Promise<boolean>;
type Launcher = "auto" | "tmux" | "zellij";

/** Selected-session delivery for managed tmux/zellij panes. Never types globally. */
export class TerminalSessionAdapter {
  constructor(private readonly core: HostCore, private readonly run: TerminalRunner = runProcess) {}

  async deliver(text: string): Promise<boolean> {
    if (!text) return false;
    const raw = this.core.activeSessionRaw() ?? {};
    const tmux = string(raw.tmux); if (tmux) return this.run({ command: "tmux", args: ["send-keys", "-t", tmux, "--", text, "Enter"] });
    const zellij = string(raw.zellij); if (zellij) return (await this.zellij(zellij, string(raw.zellij_pane), "write-chars", text)) && await this.zellij(zellij, string(raw.zellij_pane), "write", "13");
    return false;
  }

  async binding(binding: string): Promise<boolean> {
    const raw = this.core.activeSessionRaw() ?? {};
    const tmux = string(raw.tmux); if (tmux) return this.tmuxBinding(tmux, binding);
    const zellij = string(raw.zellij); if (zellij) return this.zellijBinding(zellij, string(raw.zellij_pane), binding);
    return false;
  }

  async newSession(input: { tool: string; name: string; command: string; cwd?: string; launcher: Launcher }): Promise<boolean> {
    if (!input.tool || !input.command) return false;
    const raw = this.core.activeSessionRaw() ?? {};
    const tmux = string(raw.tmux);
    const zellij = string(raw.zellij);
    if ((input.launcher === "auto" || input.launcher === "tmux") && tmux) {
      return this.run({ command: "tmux", args: ["new-window", "-t", tmux, "-n", input.name, ...(input.cwd ? ["-c", input.cwd] : []), "--", input.command] });
    }
    if ((input.launcher === "auto" || input.launcher === "zellij") && zellij) {
      // zellij receives the configured command as a command argument; this is
      // intentionally restricted to an already-selected managed session.
      return this.run({ command: "zellij", args: ["--session", zellij, "action", "new-pane", "--name", input.name, ...(input.cwd ? ["--cwd", input.cwd] : []), "--", input.command] });
    }
    return false;
  }

  private async tmuxBinding(pane: string, binding: string): Promise<boolean> {
    const key = tmuxKey(binding);
    return key.literal
      ? this.run({ command: "tmux", args: ["send-keys", "-t", pane, "-l", "--", key.value] })
      : this.run({ command: "tmux", args: ["send-keys", "-t", pane, "--", key.value] });
  }

  private async zellijBinding(session: string, pane: string, binding: string): Promise<boolean> {
    const key = tmuxKey(binding);
    const codes = zellijBytes(key.value);
    return codes ? this.zellij(session, pane, "write", ...codes.map(String)) : key.literal ? this.zellij(session, pane, "write-chars", key.value) : false;
  }

  private zellij(session: string, pane: string, action: string, ...values: string[]): Promise<boolean> {
    return this.run({ command: "zellij", args: ["--session", session, "action", action, ...(pane ? ["--pane-id", pane] : []), ...values] });
  }
}

const names: Record<string, string> = { enter: "Enter", escape: "Escape", esc: "Escape", tab: "Tab", space: "Space", backspace: "BSpace", delete: "DC", up: "Up", down: "Down", left: "Left", right: "Right", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown" };
function string(value: unknown): string { return typeof value === "string" ? value : ""; }
function tmuxKey(binding: string): { value: string; literal: boolean } {
  const value = binding.trim(); const lower = value.toLowerCase();
  if (names[lower]) return { value: names[lower]!, literal: false };
  if (/^f([1-9]|1[0-2])$/i.test(value)) return { value: value.toUpperCase(), literal: false };
  if (/^(ctrl|control|c)-.$/i.test(value)) return { value: `C-${value.at(-1)}`, literal: false };
  if (/^(alt|meta|m)-.$/i.test(value)) return { value: `M-${value.at(-1)}`, literal: false };
  return value.length === 1 ? { value, literal: false } : { value, literal: true };
}
function zellijBytes(key: string): number[] | undefined {
  if (/^C-.$/.test(key)) return [key.charCodeAt(2) & 0x1f];
  const special: Record<string, number[]> = { Enter: [13], Escape: [27], Tab: [9], BSpace: [127], Space: [32] };
  return special[key] ?? (key.length === 1 ? [key.charCodeAt(0)] : undefined);
}
function runProcess(input: TerminalInvocation): Promise<boolean> {
  return new Promise((resolve) => { let child; try { child = spawn(input.command, input.args, { stdio: "ignore", windowsHide: true }); } catch { resolve(false); return; } child.once("error", () => resolve(false)); child.once("exit", (code) => resolve(code === 0)); });
}
