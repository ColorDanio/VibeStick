#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HostCore } from "./core.js";
import { loadConfigFile, loadSessionDirectory } from "./files.js";
import { createLinuxBridge, type LinuxBridgeOptions } from "./linux-bridge.js";
import { HostRuntime, type Capabilities } from "./runtime.js";
import { startDashboardServer } from "./server.js";
import type { VibeBridge } from "./bridge.js";
import type { DashboardEnvironment } from "./dashboard.js";
import { VoicePipeline, onlineTranscriber } from "./asr.js";

type Args = { config: string; sessions: string; port: number; helper?: string; address?: string };
const moduleDirectory = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));
  const config = await loadConfigFile(args.config);
  const core = new HostCore(config);
  core.replaceSessions(await loadSessionDirectory(args.sessions));
  let runtime: HostRuntime | undefined;
  const environment = (): DashboardEnvironment => {
    const diagnostics = runtime?.diagnostics();
    return {
      implementation: "host-2",
      owner: runtime?.isBleOwner() ? "active" : "inactive",
      runtime: diagnostics?.state ?? "stopped",
      capabilities: diagnostics?.capabilities ?? {
        ble: { available: false, reason: "Start Host 2.0 with the Linux BLE helper" },
        keyboard: { available: false, reason: "Start Host 2.0 with the Linux BLE helper" },
        mic: { available: false, reason: "Start Host 2.0 with the Linux BLE helper" },
        asr: { available: false, reason: "Configure an ASR provider for Host 2.0" },
      },
      ...(diagnostics?.error ? { error: diagnostics.error } : {}),
    };
  };
  const dashboard = await startDashboardServer(core, args.port, environment);
  console.log(`VibeStick TS dashboard: http://127.0.0.1:${dashboard.port}`);

  let bridge: VibeBridge | undefined;
  let deliverSelected: ((text: string) => Promise<boolean>) | undefined;
  const voice = new VoicePipeline(config.asr, onlineTranscriber, (update) => { void bridge?.publishVoice(update); });
  if (args.helper) {
    const bridgeOptions: LinuxBridgeOptions = {
      helperExecutable: args.helper,
      helperArgs: [resolve(moduleDirectory, "../../host/tools/ble_gatt_helper.py")],
      onError: (error: Error) => console.error(`capability error: ${error.message}`),
      onAsrAudio: (pcm: Uint8Array) => voice.feed(pcm),
      onRoutingActions: async (actions) => {
        for (const action of actions) {
          if (action === "asr.start") {
            if (config.asr.engine !== "online") { await bridge?.publishVoice({ state: "error", text: "Host 2.0 needs online ASR configured" }); continue; }
            voice.start();
          }
          if (action === "asr.stop") await voice.stop();
          if (action === "asr.cancel") voice.cancel();
        }
      },
      onCommand: async (command) => {
        if (command.cmd !== "voice.confirm") return;
        const text = voice.confirm();
        if (text && (!deliverSelected || !(await deliverSelected(text)))) throw new Error("voice delivery failed");
      },
      ...(args.address ? { address: args.address } : {}),
    };
    const linux = createLinuxBridge(core, bridgeOptions);
    bridge = linux.bridge;
    deliverSelected = linux.deliver;
    const { mic } = linux;
    const capabilities: Capabilities = {
      ble: { available: true }, keyboard: { available: true }, mic: { available: false, reason: "PipeWire probe pending" },
      asr: config.asr.engine === "online" && Boolean(config.asr.online.api_key)
        ? { available: true } : { available: false, reason: "Configure OpenAI-compatible online ASR for Host 2.0" },
    };
    runtime = new HostRuntime(bridge, capabilities);
    await runtime.start();
    capabilities.mic = (await mic.warmup().catch(() => false)) ? { available: true } : { available: false, reason: "PipeWire Vibe Mic unavailable" };
    console.log(`VibeStick TS runtime: ${runtime.reconcile()}`);
  } else {
    console.log("VibeStick TS runtime: degraded (no Linux BLE helper; Python traditional daemon remains available)");
  }
  const refresh = async (): Promise<void> => {
    core.replaceSessions(await loadSessionDirectory(args.sessions));
    await bridge?.sync();
  };
  const refreshTimer = setInterval(() => { void refresh().catch((error) => console.error(`session refresh failed: ${String(error)}`)); }, 1000);
  const stop = async (): Promise<void> => { clearInterval(refreshTimer); await runtime?.stop(); await dashboard.close(); };
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
