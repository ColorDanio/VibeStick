#!/usr/bin/env node
import { resolve } from "node:path";
import { HostCore } from "./core.js";
import { loadConfigFile, loadSessionDirectory } from "./files.js";
import { createLinuxBridge } from "./linux-bridge.js";
import { HostRuntime, type Capabilities } from "./runtime.js";
import { startDashboardServer } from "./server.js";

type Args = { config: string; sessions: string; port: number; helper?: string; address?: string };

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));
  const config = await loadConfigFile(args.config);
  const core = new HostCore(config);
  core.replaceSessions(await loadSessionDirectory(args.sessions));
  const dashboard = await startDashboardServer(core, args.port);
  console.log(`VibeStick TS dashboard: http://127.0.0.1:${dashboard.port}`);

  let runtime: HostRuntime | undefined;
  if (args.helper) {
    const bridgeOptions = {
      helperExecutable: args.helper,
      helperArgs: [resolve(process.cwd(), "../host/tools/ble_gatt_helper.py")],
      onError: (error: Error) => console.error(`capability error: ${error.message}`),
      ...(args.address ? { address: args.address } : {}),
    };
    const { bridge, mic } = createLinuxBridge(core, bridgeOptions);
    const capabilities: Capabilities = {
      ble: { available: true }, keyboard: { available: true }, mic: { available: false, reason: "PipeWire probe pending" },
    };
    runtime = new HostRuntime(bridge, capabilities);
    await runtime.start();
    capabilities.mic = (await mic.warmup().catch(() => false)) ? { available: true } : { available: false, reason: "PipeWire Vibe Mic unavailable" };
    console.log(`VibeStick TS runtime: ${runtime.reconcile()}`);
  } else {
    console.log("VibeStick TS runtime: degraded (no Linux BLE helper; Python traditional daemon remains available)");
  }
  const stop = async (): Promise<void> => { await runtime?.stop(); await dashboard.close(); };
  process.once("SIGINT", () => { void stop().finally(() => process.exit(0)); });
  process.once("SIGTERM", () => { void stop().finally(() => process.exit(0)); });
}

function parse(argv: string[]): Args {
  const value = (flag: string, fallback: string): string => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] ?? fallback : fallback;
  const helper = value("--linux-helper", "");
  return {
    config: value("--config", resolve(process.env.HOME ?? ".", ".vibestick/config.json")),
    sessions: value("--sessions", resolve(process.env.HOME ?? ".", ".vibestick/sessions")),
    port: Number(value("--port", "7861")),
    ...(helper ? { helper } : {}),
    ...(argv.includes("--address") ? { address: value("--address", "") } : {}),
  };
}

void main().catch((error) => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; });
