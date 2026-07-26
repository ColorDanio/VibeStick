#!/usr/bin/env node
import { homedir, userInfo } from "node:os";
import { desktopLifecyclePlan } from "./desktop-lifecycle.js";
import { executeLifecycle, nodeRunner, type LifecycleAction } from "./lifecycle-runner.js";
import { lifecycleStatusInvocation, type HostPlatform } from "./lifecycle.js";

type StartupReply = { ok: boolean; enabled: boolean; detail: string };

function argument(name: string): string {
  const position = process.argv.indexOf(name);
  return position >= 0 ? process.argv[position + 1] ?? "" : "";
}

function platform(): HostPlatform {
  if (process.platform === "darwin" || process.platform === "win32") return process.platform;
  return "linux";
}

async function main(): Promise<void> {
  const action = argument("--action");
  const executable = argument("--app");
  if (!executable || !["install", "uninstall", "status"].includes(action)) {
    throw new Error("Usage: desktop-lifecycle-cli --action install|uninstall|status --app <path>");
  }
  const currentPlatform = platform();
  const uid = typeof userInfo().uid === "number" ? userInfo().uid : 0;
  if (action === "status") {
    const result = await nodeRunner.run(lifecycleStatusInvocation(currentPlatform, uid));
    const reply: StartupReply = { ok: true, enabled: result.code === 0, detail: result.code === 0 ? "Start at login is enabled." : "Start at login is not enabled." };
    process.stdout.write(`${JSON.stringify(reply)}\n`);
    return;
  }
  const plan = desktopLifecyclePlan({ platform: currentPlatform, executable, appArguments: [], home: homedir(), uid });
  await executeLifecycle(plan, action as LifecycleAction, nodeRunner);
  const enabled = action === "install";
  const reply: StartupReply = { ok: true, enabled, detail: enabled ? "VibeConn will start at login." : "VibeConn will no longer start at login." };
  process.stdout.write(`${JSON.stringify(reply)}\n`);
}

void main().catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${JSON.stringify({ ok: false, enabled: false, detail } satisfies StartupReply)}\n`);
  process.exitCode = 1;
});
