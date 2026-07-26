import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import type { Invocation, LifecyclePlan, ManagedFile } from "./lifecycle.js";

export interface CommandResult { code: number; stdout: string; stderr: string; }
export interface CommandRunner { run(invocation: Invocation): Promise<CommandResult>; }
export interface FileSystem { write(file: ManagedFile): Promise<void>; remove(path: string): Promise<void>; }

export type LifecycleAction = "install" | "uninstall";
export interface LifecycleExecution { action: LifecycleAction; files: string[]; commands: Invocation[]; }

/** Execute a previously-reviewed platform plan. No command strings are assembled here. */
export async function executeLifecycle(plan: LifecyclePlan, action: LifecycleAction, runner: CommandRunner, files: FileSystem = nodeFiles): Promise<LifecycleExecution> {
  const commands = action === "install" ? plan.install : plan.uninstall;
  const touched: string[] = [];
  if (action === "install") {
    for (const file of plan.files) { await files.write(file); touched.push(file.path); }
  }
  for (const invocation of commands) {
    const result = await runner.run(invocation);
    if (result.code !== 0) throw new Error(`${invocation.command} failed (${result.code}): ${result.stderr || result.stdout}`);
  }
  if (action === "uninstall") {
    for (const file of plan.files) { await files.remove(file.path); touched.push(file.path); }
  }
  return { action, files: touched, commands };
}

export const nodeRunner: CommandRunner = {
  run(invocation) {
    return new Promise((resolve, reject) => {
      const child = spawn(invocation.command, invocation.args, { windowsHide: true });
      let stdout = "", stderr = "";
      child.stdout.on("data", (data) => { stdout += String(data); });
      child.stderr.on("data", (data) => { stderr += String(data); });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  },
};

const nodeFiles: FileSystem = {
  async write(file) { await mkdir(dirname(file.path), { recursive: true }); await writeFile(file.path, file.contents, { mode: 0o600 }); },
  async remove(path) { await rm(path, { force: true }); },
};
