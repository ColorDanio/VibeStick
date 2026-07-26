import { spawn } from "node:child_process";

export type HidRunner = (command: string, args: string[]) => Promise<boolean>;

/** Converts complete F14/F15 HID reports into Linux ydotool key transitions. */
export class LinuxHidFallback {
  private pressed = new Set<number>();
  constructor(private readonly run: HidRunner = runProcess) {}
  async probe(): Promise<boolean> { return this.run("ydotool", ["--help"]); }
  async report(keys: number[]): Promise<boolean> {
    const next = new Set<number>(keys.filter((key) => key === 184 || key === 185));
    let ok = true;
    for (const key of this.pressed) if (!next.has(key)) ok = (await this.run("ydotool", ["key", `${key}:0`])) && ok;
    for (const key of next) if (!this.pressed.has(key)) ok = (await this.run("ydotool", ["key", `${key}:1`])) && ok;
    this.pressed = next;
    return ok;
  }
  async release(): Promise<void> { await this.report([]); }
}
function runProcess(command: string, args: string[]): Promise<boolean> { return new Promise((resolve) => { let child; try { child = spawn(command, args, { stdio: "ignore", windowsHide: true }); } catch { resolve(false); return; } child.once("error", () => resolve(false)); child.once("exit", (code) => resolve(code === 0)); }); }
