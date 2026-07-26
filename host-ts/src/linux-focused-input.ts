import { spawn } from "node:child_process";

export type LinuxInputTool = "ydotool" | "wtype";
export interface LinuxInvocation { command: string; args: string[]; }
export type LinuxRunner = (input: LinuxInvocation) => Promise<boolean>;

/** Linux global focus input for YOLO only. Every argument stays out of a shell. */
export class LinuxFocusedInput {
  private tool: LinuxInputTool | undefined;
  constructor(private readonly run: LinuxRunner = runProcess) {}

  /** Finds a supported injector without generating input. */
  async probe(): Promise<boolean> {
    if (this.tool) return true;
    if (await this.run({ command: "ydotool", args: ["--help"] })) { this.tool = "ydotool"; return true; }
    if (await this.run({ command: "wtype", args: ["--help"] })) { this.tool = "wtype"; return true; }
    return false;
  }

  async text(value: string): Promise<boolean> {
    if (!value || !(await this.probe())) return false;
    return this.tool === "ydotool"
      ? this.run({ command: "ydotool", args: ["type", "--", value] })
      : this.run({ command: "wtype", args: [value] });
  }

  async enter(): Promise<boolean> {
    if (!(await this.probe())) return false;
    return this.tool === "ydotool"
      ? this.run({ command: "ydotool", args: ["key", "28:1"] })
      : this.run({ command: "wtype", args: ["-k", "ENTER"] });
  }

  async escapeTwice(): Promise<boolean> {
    if (!(await this.probe())) return false;
    return this.tool === "ydotool"
      ? (await this.run({ command: "ydotool", args: ["key", "1:1"] })) && await this.run({ command: "ydotool", args: ["key", "1:1"] })
      : this.run({ command: "wtype", args: ["-k", "ESC", "-k", "ESC"] });
  }
}

function runProcess(input: LinuxInvocation): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(input.command, input.args, { stdio: "ignore", windowsHide: true }); }
    catch { resolve(false); return; }
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}
