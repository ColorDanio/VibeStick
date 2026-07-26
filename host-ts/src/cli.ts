#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { HostCore } from "./core.js";
import { loadConfigFile, loadSessionDirectory, saveConfigFile } from "./files.js";
import { createLinuxBridge, type LinuxBridgeOptions } from "./linux-bridge.js";
import { HostRuntime, type Capabilities } from "./runtime.js";
import { startDashboardServer } from "./server.js";
import { VibeBridge } from "./bridge.js";
import type { DashboardEnvironment } from "./dashboard.js";
import { VoicePipeline, onlineTranscriber } from "./asr.js";
import { NodeProcessInspector, discoverProcessSessions, mergeSessions } from "./process-discovery.js";
import { publicAsrSettings, updateOnlineAsr, updateSessionLauncher, updateToolCwd, verifyOnlineAsr } from "./settings.js";
import { probeTraditionalOwner, type TraditionalOwner } from "./ownership.js";
import { diagnosticsReport } from "./diagnostics.js";
import { NobleGattTransport } from "./noble-transport.js";
import { PlatformFocusedInput } from "./focused-input.js";

type Args = { config: string; sessions: string; port: number; helper?: string; address?: string; nativeBle: boolean };
const moduleDirectory = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));
  let config = await loadConfigFile(args.config);
  const core = new HostCore(config);
  let traditionalOwner: TraditionalOwner = await probeTraditionalOwner();
  const processes = new NodeProcessInspector();
  const loadSessions = async (): Promise<void> => {
    const files = await loadSessionDirectory(args.sessions);
    const live = await processes.list().then((items) => discoverProcessSessions(config, items)).catch(() => []);
    core.replaceSessions(mergeSessions(files, live));
  };
  await loadSessions();
  let runtime: HostRuntime | undefined;
  const environment = (): DashboardEnvironment => {
    const diagnostics = runtime?.diagnostics();
    return {
      implementation: "host-2",
      owner: runtime?.isBleOwner() ? "active" : "inactive",
      runtime: diagnostics?.state ?? "stopped",
      traditional_owner: traditionalOwner,
      capabilities: diagnostics?.capabilities ?? {
        ble: { available: false, reason: "Start Host 2.0 with the Linux BLE helper" },
        keyboard: { available: false, reason: "Start Host 2.0 with the Linux BLE helper" },
        mic: { available: false, reason: "Start Host 2.0 with the Linux BLE helper" },
        asr: { available: false, reason: "Configure an ASR provider for Host 2.0" },
        yolo: { available: false, reason: "Start the Host 2.0 runtime" },
      },
      config: { path: args.config, asr_engine: config.asr.engine, asr_api_base: config.asr.online.api_base, asr_model: config.asr.online.model, online_asr_configured: config.asr.engine === "online" && Boolean(config.asr.online.api_key), session_launcher: config.session_launcher, tools: config.tools.map((tool) => ({ id: tool.id, name: tool.name, cwd: tool.cwd ?? "" })) },
      ...(diagnostics?.error ? { error: diagnostics.error } : {}),
    };
  };
  const dashboard = await startDashboardServer(core, args.port, environment, {
    async updateOnlineAsr(body) { config = updateOnlineAsr(config, body); await saveConfigFile(args.config, config); return publicAsrSettings(config); },
    async testOnlineAsr() { return verifyOnlineAsr(config); },
    async updateSessionLauncher(body) { config = updateSessionLauncher(config, body); await saveConfigFile(args.config, config); return { session_launcher: config.session_launcher }; },
    async updateToolCwd(body) {
      const rawCwd = typeof body === "object" && body !== null && "cwd" in body && typeof (body as { cwd?: unknown }).cwd === "string" ? (body as { cwd: string }).cwd.trim() : "";
      const cwd = rawCwd === "~" ? homedir() : rawCwd.startsWith("~/") ? resolve(homedir(), rawCwd.slice(2)) : rawCwd ? resolve(rawCwd) : "";
      const candidate = updateToolCwd(config, { ...(typeof body === "object" && body !== null ? body : {}), cwd });
      const id = typeof body === "object" && body !== null && "id" in body && typeof (body as { id?: unknown }).id === "string" ? (body as { id: string }).id : "";
      const changed = candidate.tools.find((tool) => tool.id === id);
      if (!changed) throw new Error("Unknown Agent CLI tool");
      if (changed.cwd) {
        const directory = await stat(resolve(changed.cwd)).catch(() => undefined);
        if (!directory?.isDirectory()) throw new Error("Working directory does not exist");
      }
      config = candidate; await saveConfigFile(args.config, config); return { id: changed.id, cwd: changed.cwd ?? "" };
    },
  }, () => diagnosticsReport(core, environment(), { platform: process.platform, arch: process.arch, runtime: `node ${process.version}` }));
  console.log(`VibeStick TS dashboard: http://127.0.0.1:${dashboard.port}`);

  let bridge: VibeBridge | undefined;
  let commands: ReturnType<typeof createLinuxBridge>["commands"] | undefined;
  let voiceMode: "agent" | "yolo" = "agent";
  const ownerPermission = async () => {
    traditionalOwner = await probeTraditionalOwner();
    return traditionalOwner.state === "running"
      ? { allowed: false, reason: `${traditionalOwner.detail ?? "Python 1.x is active."} Stop Python 1.x before Host 2.0 takes BLE.` }
      : { allowed: true, reason: "" };
  };
  const voice = new VoicePipeline(config.asr, onlineTranscriber, (update) => { void bridge?.publishVoice(update); });
  if (args.helper) {
    const bridgeOptions: LinuxBridgeOptions = {
      helperExecutable: args.helper,
      helperArgs: [resolve(moduleDirectory, "../../host/tools/ble_gatt_helper.py")],
      onError: (error: Error) => { console.error(`capability error: ${error.message}`); runtime?.reportError(error); },
      onConnectionState: (connected: boolean) => runtime?.onBleConnectionState(connected),
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
        if (command.cmd === "voice.start") { voiceMode = command.mode === "yolo" ? "yolo" : "agent"; return; }
        if (command.cmd === "voice.cancel") { voiceMode = "agent"; return; }
        if (command.cmd === "voice.stop" && voiceMode === "yolo") {
          const text = voice.confirm(); voiceMode = "agent";
          if (text && (!commands || !(await commands.focusedText(text)))) throw new Error("YOLO focused delivery failed");
          return;
        }
        if (command.cmd === "voice.confirm") {
          const text = voice.confirm();
          if (text && (!commands || !(await commands.deliver(text)))) throw new Error("voice delivery failed");
          return;
        }
        if (command.cmd === "inference.cancel") {
          const tool = config.tools.find((item) => item.id === core.snapshot().selected_tool);
          if (!commands || !(await commands.binding(tool?.bindings.cancel || "escape"))) throw new Error("inference cancel failed");
          return;
        }
        if (command.cmd === "fn.activate") {
          const tool = config.tools.find((item) => item.id === core.snapshot().selected_tool);
          const binding = command.fn ? tool?.bindings[command.fn] : undefined;
          if (!binding || !commands || !(await commands.binding(binding))) throw new Error("custom function failed");
          return;
        }
        if (command.cmd === "session.new") {
          const tool = config.tools.find((item) => item.id === core.snapshot().selected_tool);
          const commandLine = tool?.command || tool?.process || "";
          const ok = Boolean(tool && commands && await commands.newSession({
            tool: tool.id, name: tool.name, command: commandLine,
            ...(tool.cwd ? { cwd: tool.cwd } : {}),
            launcher: config.session_launcher,
          }));
          if (!ok) throw new Error("new session failed");
          core.store.requestNewSession();
          return;
        }
        if (command.cmd === "yolo.enter") {
          if (!commands || !(await commands.focusedEnter())) throw new Error("YOLO enter failed");
          return;
        }
        if (command.cmd === "yolo.escape") {
          if (!commands || !(await commands.focusedEscape())) throw new Error("YOLO escape failed");
        }
      },
      ...(args.address ? { address: args.address } : {}),
    };
    const linux = createLinuxBridge(core, bridgeOptions);
    bridge = linux.bridge;
    commands = linux.commands;
    const { mic } = linux;
    const capabilities: Capabilities = {
      ble: { available: true }, keyboard: { available: true }, mic: { available: false, reason: "PipeWire probe pending" },
      asr: config.asr.engine === "online" && Boolean(config.asr.online.api_key)
        ? { available: true } : { available: false, reason: "Configure OpenAI-compatible online ASR for Host 2.0" },
      yolo: { available: false, reason: "YOLO needs ydotool or wtype focused-input setup on Linux" },
    };
    runtime = new HostRuntime(bridge, capabilities, 2_000, ownerPermission);
    await runtime.start();
    capabilities.mic = (await mic.warmup().catch(() => false)) ? { available: true } : { available: false, reason: "PipeWire Vibe Mic unavailable" };
    console.log(`VibeStick TS runtime: ${runtime.reconcile()}`);
  } else if (args.nativeBle || process.platform !== "linux") {
    const focused = new PlatformFocusedInput();
    bridge = new VibeBridge(new NobleGattTransport(args.address ?? ""), core, {
      onConnectionState: (connected) => runtime?.onBleConnectionState(connected),
      onAudio: (destination, pcm) => { if (destination === "asr") voice.feed(pcm); },
      onActions: async (actions) => {
        for (const action of actions) {
          if (action === "asr.start") {
            if (config.asr.engine !== "online" || !config.asr.online.api_key) await bridge?.publishVoice({ state: "error", text: "YOLO needs online ASR configured" });
            else voice.start();
          }
          if (action === "asr.stop") await voice.stop();
          if (action === "asr.cancel") voice.cancel();
          if (action === "relay.start" || action === "relay.stop") runtime?.reportError("Vibe Mic is unavailable for the native BLE adapter");
        }
      },
      onCommand: async (command) => {
        if (command.cmd === "voice.start") { voiceMode = command.mode === "yolo" ? "yolo" : "agent"; return; }
        if (command.cmd === "voice.cancel") { voiceMode = "agent"; return; }
        if (command.cmd === "voice.stop" && voiceMode === "yolo") {
          const text = voice.confirm(); voiceMode = "agent";
          if (text && !(await focused.text(text))) throw new Error("YOLO focused delivery failed");
          return;
        }
        if (command.cmd === "yolo.enter") {
          if (!(await focused.enter())) throw new Error("YOLO Enter failed");
          return;
        }
        if (command.cmd === "yolo.escape") {
          if (!(await focused.escapeTwice())) throw new Error("YOLO Escape failed");
          return;
        }
        if (command.cmd === "voice.confirm") {
          if (voice.confirm()) throw new Error("Agent CLI delivery is unavailable for the native BLE adapter");
        }
      },
      onEffectError: (error) => {
        console.error(`native BLE action failed: ${error.message}`);
        runtime?.reportError(error);
        void bridge?.publishVoice({ state: "error", text: error.message.slice(0, 96) });
      },
    });
    const capabilities: Capabilities = {
      ble: { available: true },
      keyboard: { available: false, reason: "Vibe Mic HID/system key fallback is not implemented yet" },
      mic: { available: false, reason: "Platform virtual microphone is not implemented yet" },
      asr: { available: false, reason: "Agent CLI session delivery is not implemented; YOLO supports online ASR only" },
      yolo: process.platform === "darwin" || process.platform === "win32"
        ? config.asr.engine === "online" && Boolean(config.asr.online.api_key)
          ? { available: true, reason: "Requires macOS Accessibility or a normal-integrity Windows foreground app" }
          : { available: false, reason: "Configure online ASR before using YOLO" }
        : { available: false, reason: "Native YOLO focused input is available only on macOS and Windows" },
    };
    runtime = new HostRuntime(bridge, capabilities, 2_000, ownerPermission);
    await runtime.start();
    console.log(`VibeStick TS native BLE runtime: ${runtime.reconcile()}`);
  } else {
    console.log("VibeStick TS runtime: degraded (no Linux BLE helper; Python traditional daemon remains available)");
  }
  const refresh = async (): Promise<void> => {
    await loadSessions();
    await bridge?.sync();
  };
  const refreshTimer = setInterval(() => { void refresh().catch((error) => console.error(`session refresh failed: ${String(error)}`)); }, 1000);
  const ownerTimer = setInterval(() => { void probeTraditionalOwner().then((next) => { traditionalOwner = next; }); }, 5000);
  const stop = async (): Promise<void> => { clearInterval(refreshTimer); clearInterval(ownerTimer); await runtime?.stop(); await dashboard.close(); };
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
    nativeBle: argv.includes("--native-ble"),
  };
}

void main().catch((error) => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; });
