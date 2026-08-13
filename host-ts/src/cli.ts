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
import { applyPythonLocalAsr, downloadPythonLocalAsr, pythonLocalTranscriber } from "./local-asr.js";
import type { LocalAsrModelStatus } from "./server.js";
import { pythonSessionDiscovery } from "./session-discovery.js";
import { NodeProcessInspector, discoverProcessSessions, mergeSessions } from "./process-discovery.js";
import { publicAsrSettings, updateMicBindings, updateOnlineAsr, updateSessionLauncher, updateToolCwd, verifyOnlineAsr } from "./settings.js";
import { probeTraditionalOwner, type TraditionalOwner } from "./ownership.js";
import { diagnosticsReport } from "./diagnostics.js";
import { NobleGattTransport } from "./noble-transport.js";
import { PlatformFocusedInput } from "./focused-input.js";
import { PipeWireVibeMicSink } from "./pipewire-mic.js";
import { LinuxFocusedInput } from "./linux-focused-input.js";
import { TerminalSessionAdapter } from "./terminal-session.js";
import { LinuxHidFallback } from "./linux-hid-fallback.js";
import { ForegroundTargetProbe } from "./foreground-target.js";
import { TranscriptionHistory } from "./transcription-history.js";

type Args = { config: string; sessions: string; port: number; helper?: string; address?: string; nativeBle: boolean };
const moduleDirectory = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));
  let config = await loadConfigFile(args.config);
  const core = new HostCore(config);
  const transcriptionHistory = new TranscriptionHistory(resolve(homedir(), ".vibestick/transcriptions.jsonl"));
  core.setTranscriptionHistory(await transcriptionHistory.load());
  core.onTranscript((record) => { void transcriptionHistory.append(record).catch((error) => console.error(`transcript history failed: ${String(error)}`)); });
  const foregroundTarget = new ForegroundTargetProbe();
  let traditionalOwner: TraditionalOwner = await probeTraditionalOwner();
  const processes = new NodeProcessInspector();
  const compatibilityExecutable = process.env.VIBECONN_PYTHON || process.env.VIBESTICK_LINUX_HELPER || "python3";
  const compatibilityDiscoveryHelper = process.env.VIBECONN_SESSION_DISCOVERY_HELPER || resolve(moduleDirectory, "../../host/tools/session_discovery_helper.py");
  let compatibilitySessions: import("./store.js").SessionRecord[] = [];
  let nextCompatibilityDiscovery = 0;
  const loadSessions = async (): Promise<void> => {
    const files = await loadSessionDirectory(args.sessions);
    if (args.helper) {
      if (Date.now() >= nextCompatibilityDiscovery) {
        nextCompatibilityDiscovery = Date.now() + 4_000;
        compatibilitySessions = await pythonSessionDiscovery(compatibilityExecutable, compatibilityDiscoveryHelper, config)
          .catch((error) => { console.error(`session discovery failed: ${error instanceof Error ? error.message : String(error)}`); return compatibilitySessions; });
      }
      // Adapter status files remain authoritative for their tool. The helper
      // contributes only process/discovered records for tools without one.
      const adapterTools = new Set(files.map((record) => record.status.tool));
      core.replaceSessions([...files, ...compatibilitySessions.filter((record) => !adapterTools.has(record.status.tool))]);
      return;
    }
    const live = await processes.list().then((items) => discoverProcessSessions(config, items)).catch(() => []);
    core.replaceSessions(mergeSessions(files, live));
  };
  await loadSessions();
  core.refreshUsage();
  let runtime: HostRuntime | undefined;
  let bridge: VibeBridge | undefined;
  let scanSticks: (() => Promise<{ name: string; address: string; rssi?: number | null; paired?: boolean; connected?: boolean }[]>) | undefined;
  let pairedSticks: (() => Promise<{ name: string; address: string; rssi?: number | null; paired?: boolean; connected?: boolean }[]>) | undefined;
  let connectStick: ((body: unknown) => Promise<{ address: string }>) | undefined;
  let pairStick: ((body: unknown) => Promise<void>) | undefined;
  let unpairStick: ((body: unknown) => Promise<void>) | undefined;
  let testYoloFocused: (() => Promise<{ available: boolean; detail: string }>) | undefined;
  let localModelStatus: LocalAsrModelStatus = config.asr.engine === "faster-whisper"
    ? { model: config.asr.model, state: "applied", progress: 100, detail: "Active model" }
    : { model: config.asr.model, state: "idle", progress: 0 };
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
      config: { path: args.config, asr_engine: config.asr.engine, asr_api_base: config.asr.online.api_base, asr_model: config.asr.engine === "online" ? config.asr.online.model : config.asr.model, asr_online_model: config.asr.online.model, online_asr_configured: config.asr.engine === "online" && Boolean(config.asr.online.api_key), mic_button_a: config.mic.buttonA, mic_button_b: config.mic.buttonB, session_launcher: config.session_launcher, tools: config.tools.map((tool) => ({ id: tool.id, name: tool.name, cwd: tool.cwd ?? "" })) },
      ...(diagnostics?.error ? { error: diagnostics.error } : {}),
    };
  };
  const dashboard = await startDashboardServer(core, args.port, environment, {
    async updateOnlineAsr(body) {
      const candidate = updateOnlineAsr(config, body);
      config = candidate;
      await saveConfigFile(args.config, config);
      return publicAsrSettings(config);
    },
    async startLocalAsrDownload(body) {
      const candidate = updateOnlineAsr(config, body);
      if (localModelStatus.state === "downloading") throw new Error(`Already downloading ${localModelStatus.model}`);
      localModelStatus = { model: candidate.asr.model, state: "downloading", progress: 0, detail: "Starting download…" };
      void downloadPythonLocalAsr(localAsrExecutable, localAsrHelper, candidate.asr, (progress) => {
        if (localModelStatus.model === candidate.asr.model && localModelStatus.state === "downloading")
          localModelStatus = { ...localModelStatus, progress, detail: `Downloading ${candidate.asr.model}…` };
      }).then(() => {
        localModelStatus = { model: candidate.asr.model, state: "ready", progress: 100, detail: "Downloaded and ready to apply" };
      }).catch((error) => {
        localModelStatus = { model: candidate.asr.model, state: "error", progress: 0, detail: error instanceof Error ? error.message : String(error) };
      });
      return localModelStatus;
    },
    localAsrDownloadStatus() { return localModelStatus; },
    async applyLocalAsr(body) {
      const candidate = updateOnlineAsr(config, body);
      localModelStatus = { model: candidate.asr.model, state: "applying", progress: 100, detail: "Validating local model…" };
      try {
        await applyPythonLocalAsr(localAsrExecutable, localAsrHelper, candidate.asr);
        config = candidate;
        await saveConfigFile(args.config, config);
        localModelStatus = { model: candidate.asr.model, state: "applied", progress: 100, detail: "Applied · restart required" };
        return publicAsrSettings(config);
      } catch (error) {
        localModelStatus = { model: candidate.asr.model, state: "error", progress: 0, detail: error instanceof Error ? error.message : String(error) };
        throw error;
      }
    },
    async testOnlineAsr() { return verifyOnlineAsr(config); },
    async testYoloFocused() {
      if (!testYoloFocused) throw new Error("YOLO permission testing is available only with a native focused-input adapter");
      return testYoloFocused();
    },
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
    async updateMicBindings(body) {
      config = updateMicBindings(config, body); await saveConfigFile(args.config, config);
      core.updateMicConfig(config.mic);
      // Apply shortcut changes immediately when the Stick is already
      // connected. A later reconnect also performs this sync automatically.
      const device_synced = bridge ? await bridge.syncDeviceConfig() : false;
      return { button_a: config.mic.buttonA, button_b: config.mic.buttonB, device_synced };
    },
    async scanSticks() {
      if (!scanSticks) throw new Error("Stick scanning is available only with the Linux BLE helper");
      return scanSticks();
    },
    async pairedSticks() {
      if (!pairedSticks) throw new Error("Paired VibeStick devices are available only with the Linux BLE helper");
      return pairedSticks();
    },
    async connectStick(body) {
      if (!connectStick) throw new Error("Stick selection is available only with the Linux BLE helper");
      return connectStick(body);
    },
    async pairStick(body) { if (!pairStick) throw new Error("Bluetooth pairing is available only with the Linux BLE helper"); await pairStick(body); },
    async unpairStick(body) { if (!unpairStick) throw new Error("Bluetooth unpair is available only with the Linux BLE helper"); await unpairStick(body); },
  }, () => diagnosticsReport(core, environment(), { platform: process.platform, arch: process.arch, runtime: `node ${process.version}` }));
  console.log(`VibeConn 2.0 dashboard: http://127.0.0.1:${dashboard.port}`);

  let commands: ReturnType<typeof createLinuxBridge>["commands"] | undefined;
  let refreshOwnedCapabilities: (() => Promise<void>) | undefined;
  let helperCapabilitiesProbed = false;
  let voiceMode: "agent" | "yolo" = "agent";
  const ownerPermission = async () => {
    traditionalOwner = await probeTraditionalOwner();
    return traditionalOwner.state === "running"
      ? { allowed: false, reason: `${traditionalOwner.detail ?? "Python 1.x is active."} Stop Python 1.x before Host 2.0 takes BLE.` }
      : { allowed: true, reason: "" };
  };
  const localAsr = config.asr.engine === "faster-whisper" || (config.asr.engine === "command" && Boolean(config.asr.command.trim()));
  const asrReady = localAsr || (config.asr.engine === "online" && Boolean(config.asr.online.api_key));
  const localAsrExecutable = compatibilityExecutable;
  const localAsrHelper = process.env.VIBECONN_LOCAL_ASR_HELPER || resolve(moduleDirectory, "../../host/tools/asr_helper.py");
  const transcriber = config.asr.engine === "online"
    ? onlineTranscriber : pythonLocalTranscriber(localAsrExecutable, localAsrHelper);
  const voice = new VoicePipeline(config.asr, transcriber, (update) => { void bridge?.publishVoice(update); });
  if (args.helper) {
    const bridgeOptions: LinuxBridgeOptions = {
      helperExecutable: args.helper,
      helperArgs: [process.env.VIBECONN_LINUX_HELPER_SCRIPT || resolve(moduleDirectory, "../../host/tools/ble_gatt_helper.py")],
      onError: (error: Error) => { console.error(`capability error: ${error.message}`); runtime?.reportError(error); },
      onConnectionState: (connected: boolean) => {
        if (!connected) helperCapabilitiesProbed = false;
        runtime?.onBleConnectionState(connected);
      },
      onAsrAudio: (pcm: Uint8Array) => voice.feed(pcm),
      onRoutingActions: async (actions) => {
        for (const action of actions) {
          if (action === "asr.start") {
            if (!asrReady) { await bridge?.publishVoice({ state: "error", text: "Host 2.0 ASR is not configured" }); continue; }
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
          if (text) core.recordDelivery("yolo");
          return;
        }
        if (command.cmd === "voice.confirm") {
          const text = voice.confirm();
          if (text && (!commands || !(await commands.deliver(text)))) throw new Error("voice delivery failed");
          if (text) core.recordDelivery("agent");
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
    // Device-management requests share one helper process and one BlueZ
    // owner. Serialize them so a scan/pair/connect request cannot terminate
    // a pending command from a previous request.
    let deviceOperation: Promise<unknown> = Promise.resolve();
    const withDeviceOperation = <T>(operation: () => Promise<T>): Promise<T> => {
      const run = deviceOperation.then(operation, operation);
      deviceOperation = run.then(() => undefined, () => undefined);
      return run;
    };
    scanSticks = () => withDeviceOperation(() => linux.transport.scan());
    pairedSticks = () => withDeviceOperation(() => linux.transport.paired());
    connectStick = (body) => withDeviceOperation(async () => {
      const address = typeof body === "object" && body !== null && typeof (body as { address?: unknown }).address === "string"
        ? (body as { address: string }).address.trim() : "";
      if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i.test(address)) throw new Error("Invalid Stick address");
      // The helper owns one BleakClient and HostRuntime owns one bridge: stop
      // the old link before selecting the new device, never two at once.
      await runtime?.stop();
      core.clearDevice();
      linux.transport.setTargetAddress(address);
      await runtime?.start();
      // HostRuntime records a transport failure as degraded instead of
      // throwing. The device-management API must surface that failure to the
      // button; otherwise Activate looks like a successful no-op.
      if (!runtime?.isBleOwner())
        throw new Error(runtime?.diagnostics().error ?? "Could not activate this VibeStick");
      return { address };
    });
    const deviceAddress = (body: unknown): string => {
      const address = typeof body === "object" && body !== null && typeof (body as { address?: unknown }).address === "string" ? (body as { address: string }).address.trim() : "";
      if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/i.test(address)) throw new Error("Invalid Stick address");
      return address;
    };
    pairStick = (body) => withDeviceOperation(async () => {
      const address = deviceAddress(body);
      // Pair and activate are one transaction. The old implementation
      // returned after a temporary pairing connection, then the UI started a
      // second HTTP request; that gap allowed the helper/reconnect timer to
      // exit before the real Host bridge ever synchronized the Stick.
      const previousAddress = runtime?.isBleOwner() ? linux.transport.address : undefined;
      await runtime?.stop();
      core.clearDevice();
      linux.transport.setTargetAddress("");
      try {
        await linux.transport.pair(address);
        linux.transport.setTargetAddress(address);
        await runtime?.start();
        if (!runtime?.isBleOwner())
          throw new Error(runtime?.diagnostics().error ?? "Pairing succeeded but activation failed");
      } catch (error) {
        // Do not leave a half-connected new device behind. Restore the prior
        // active Stick only after the temporary pairing client released BlueZ.
        if (runtime && runtime.state !== "stopped") await runtime.stop();
        if (previousAddress) {
          linux.transport.setTargetAddress(previousAddress);
          await runtime?.start();
        }
        throw error;
      }
    });
    unpairStick = (body) => withDeviceOperation(async () => {
      const address = deviceAddress(body);
      if (linux.transport.address?.toUpperCase() === address.toUpperCase()) {
        await runtime?.stop();
        core.clearDevice();
        linux.transport.setTargetAddress("");
      }
      await linux.transport.unpair(address);
    });
    const { mic } = linux;
    const capabilities: Capabilities = {
      ble: { available: true },
      keyboard: { available: false, reason: "VibeConn 2.0 will initialize keyboard fallback after BLE handoff" },
      mic: { available: false, reason: "VibeConn 2.0 will probe PipeWire after BLE handoff" },
      asr: asrReady
        ? { available: true, ...(localAsr ? { reason: `Local ${config.asr.engine} via model adapter` } : {}) }
        : { available: false, reason: "Configure local ASR or an OpenAI-compatible online ASR provider" },
      yolo: { available: false, reason: "VibeConn 2.0 will probe focused input after BLE handoff" },
    };
    runtime = new HostRuntime(bridge, capabilities, 2_000, ownerPermission);
    await runtime.start();
    refreshOwnedCapabilities = async () => {
      if (!runtime?.isBleOwner() || helperCapabilitiesProbed) return;
      helperCapabilitiesProbed = true;
      capabilities.keyboard = { available: true };
      capabilities.mic = (await mic.warmup().catch(() => false))
        ? { available: true } : { available: false, reason: "PipeWire Vibe Mic unavailable" };
      capabilities.yolo = await commands?.focusedProbe()
        ? { available: true, reason: "Focused-input capability ready" }
        : { available: false, reason: "YOLO needs ydotool or wtype focused-input setup on Linux" };
      runtime.reconcile();
    };
    await refreshOwnedCapabilities();
    console.log(`VibeConn 2.0 runtime: ${runtime.reconcile()}`);
  } else if (args.nativeBle || process.platform !== "linux") {
    const focused = process.platform === "linux" ? new LinuxFocusedInput() : new PlatformFocusedInput();
    const nativeMic = process.platform === "linux" ? new PipeWireVibeMicSink(config.mic.enabled) : undefined;
    const nativeHid = process.platform === "linux" ? new LinuxHidFallback() : undefined;
    const terminals = process.platform === "win32" ? undefined : new TerminalSessionAdapter(core);
    bridge = new VibeBridge(new NobleGattTransport(args.address ?? ""), core, {
      onConnectionState: (connected) => runtime?.onBleConnectionState(connected),
      onAudio: (destination, pcm) => {
        if (destination === "mic") nativeMic?.feed(pcm);
        else voice.feed(pcm);
      },
      onHid: (keycodes) => { void nativeHid?.report(keycodes).then((ok) => { if (!ok) runtime?.reportError("Vibe Mic HID fallback failed"); }); },
      onActions: async (actions) => {
        for (const action of actions) {
          if (action === "asr.start") {
            if (!asrReady) await bridge?.publishVoice({ state: "error", text: "YOLO ASR is not configured" });
            else voice.start();
          }
          if (action === "asr.stop") await voice.stop();
          if (action === "asr.cancel") voice.cancel();
          if (action === "relay.prepare" || action === "relay.restore" || action === "relay.start" || action === "relay.stop") {
            if (nativeMic) await nativeMic.apply([action]);
            else runtime?.reportError("Vibe Mic is unavailable for the native BLE adapter");
          }
        }
      },
      onCommand: async (command) => {
        if (command.cmd === "voice.start") { voiceMode = command.mode === "yolo" ? "yolo" : "agent"; return; }
        if (command.cmd === "voice.cancel") { voiceMode = "agent"; return; }
        if (command.cmd === "voice.stop" && voiceMode === "yolo") {
          const text = voice.confirm(); voiceMode = "agent";
          if (text && !(await focused.text(text))) throw new Error("YOLO focused delivery failed");
          if (text) core.recordDelivery("yolo");
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
          const text = voice.confirm();
          if (text && (!terminals || !(await terminals.deliver(text)))) throw new Error("Agent CLI delivery failed: select a tmux or zellij session");
          if (text) core.recordDelivery("agent");
          return;
        }
        if (command.cmd === "inference.cancel") {
          const tool = config.tools.find((item) => item.id === core.snapshot().selected_tool);
          if (!terminals || !(await terminals.binding(tool?.bindings.cancel || "escape"))) throw new Error("Agent CLI cancel failed");
          return;
        }
        if (command.cmd === "fn.activate") {
          const tool = config.tools.find((item) => item.id === core.snapshot().selected_tool);
          const binding = command.fn ? tool?.bindings[command.fn] : undefined;
          if (!binding || !terminals || !(await terminals.binding(binding))) throw new Error("Agent CLI custom function failed");
          return;
        }
        if (command.cmd === "session.new") {
          const tool = config.tools.find((item) => item.id === core.snapshot().selected_tool);
          const ok = Boolean(tool && terminals && await terminals.newSession({ tool: tool.id, name: tool.name, command: tool.command || tool.process || "", ...(tool.cwd ? { cwd: tool.cwd } : {}), launcher: config.session_launcher }));
          if (!ok) throw new Error("New session requires an existing tmux or zellij session");
          core.store.requestNewSession();
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
      keyboard: nativeHid ? { available: false, reason: "Vibe Mic HID fallback probe pending" } : { available: false, reason: "Vibe Mic HID/system key fallback is not implemented yet" },
      mic: nativeMic ? { available: false, reason: "PipeWire Vibe Mic probe pending" } : { available: false, reason: "Platform virtual microphone is not implemented yet" },
      asr: terminals && asrReady
        ? { available: true, reason: "Delivery requires the selected session to be tmux or zellij" }
        : { available: false, reason: terminals ? "Configure local or online ASR for Agent CLI delivery" : "Agent CLI session delivery is not implemented on Windows" },
      yolo: process.platform === "darwin" || process.platform === "win32" || process.platform === "linux"
        ? asrReady
          ? { available: false, reason: "Run the focused-input permission test in Settings", testable: true }
          : { available: false, reason: "Configure local or online ASR before using YOLO" }
        : { available: false, reason: "Native YOLO focused input is unavailable on this platform" },
    };
    testYoloFocused = async () => {
      if (!asrReady) {
        capabilities.yolo = { available: false, reason: "Configure local or online ASR before testing YOLO", testable: false };
        return { available: false, detail: capabilities.yolo.reason ?? "" };
      }
      const available = await focused.probe();
      capabilities.yolo = available
        ? { available: true, reason: "Focused-input permission probe passed", testable: true }
        : { available: false, reason: "Focused-input permission probe failed; grant macOS Accessibility or focus a normal-integrity Windows app", testable: true };
      runtime?.reconcile();
      return { available, detail: capabilities.yolo.reason ?? "" };
    };
    runtime = new HostRuntime(bridge, capabilities, 2_000, ownerPermission);
    await runtime.start();
    if (nativeMic) {
      capabilities.mic = (await nativeMic.warmup().catch(() => false))
        ? { available: true } : { available: false, reason: "PipeWire Vibe Mic unavailable" };
      runtime.reconcile();
    }
    if (nativeHid) {
      capabilities.keyboard = (await nativeHid.probe().catch(() => false))
        ? { available: true } : { available: false, reason: "ydotool Vibe Mic HID fallback unavailable" };
      runtime.reconcile();
    }
    console.log(`VibeConn 2.0 native BLE runtime: ${runtime.reconcile()}`);
  } else {
    console.log("VibeConn 2.0 runtime: degraded (no Linux BLE helper; Python 1.x remains available)");
  }
  const refresh = async (): Promise<void> => {
    await loadSessions();
    const mode = core.snapshot().device_mode;
    core.setForegroundTarget(mode === "mic" || mode === "yolo" ? await foregroundTarget.current() : undefined);
    // While VibeConn 1.x owns BLE, the 2.0 bridge is intentionally never
    // started. Keep its loopback dashboard fresh without asking a missing
    // helper transport to write characteristics every second.
    if (runtime?.isBleOwner()) {
      await bridge?.sync();
      await refreshOwnedCapabilities?.();
    }
  };
  const refreshTimer = setInterval(() => { void refresh().catch((error) => console.error(`session refresh failed: ${String(error)}`)); }, 1000);
  // Session/status discovery stays responsive, while usage metrics are
  // intentionally sampled only every 30 seconds and then pushed to clients.
  const usageTimer = setInterval(() => {
    void (async () => {
      core.refreshUsage();
      if (runtime?.isBleOwner()) await bridge?.syncUsage();
    })().catch((error) => console.error(`usage refresh failed: ${String(error)}`));
  }, 30_000);
  const ownerTimer = setInterval(() => { void probeTraditionalOwner().then((next) => { traditionalOwner = next; }); }, 5000);
  const stop = async (): Promise<void> => { clearInterval(refreshTimer); clearInterval(usageTimer); clearInterval(ownerTimer); await runtime?.stop(); await dashboard.close(); };
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
