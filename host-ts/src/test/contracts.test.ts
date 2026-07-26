import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configToWire, normalizeConfig } from "../config.js";
import { keycodesFromReport } from "../hid.js";
import { BLE, sessionsToWire, statusToWire } from "../protocol.js";
import { transition, type AudioRoute } from "../routing.js";
import { SendQueue } from "../queue.js";
import { SessionSelection } from "../session.js";
import { HostSessionStore } from "../store.js";
import { HostCore } from "../core.js";
import { dashboardRequest } from "../dashboard.js";
import { loadConfigFile, loadSessionDirectory, saveConfigFile } from "../files.js";
import { lifecyclePlan, lifecycleStatusInvocation } from "../lifecycle.js";
import { executeLifecycle, type CommandRunner, type FileSystem } from "../lifecycle-runner.js";
import { VibeBridge } from "../bridge.js";
import { MemoryGattTransport } from "../transport.js";
import { HostRuntime } from "../runtime.js";
import { LinuxCommandAdapter } from "../linux-bridge.js";
import { LinuxVibeMicSink } from "../mic-sink.js";
import { PipeWireVibeMicSink, applyGain } from "../pipewire-mic.js";
import { startDashboardServer } from "../server.js";
import { VoicePipeline, wav, type AsrTranscriber } from "../asr.js";
import { pythonLocalTranscriber } from "../local-asr.js";
import { discoverProcessSessions, mergeSessions } from "../process-discovery.js";
import { publicAsrSettings, updateOnlineAsr, updateSessionLauncher, updateToolCwd, verifyOnlineAsr } from "../settings.js";
import { probeTraditionalOwner } from "../ownership.js";
import { diagnosticsReport } from "../diagnostics.js";
import { NobleGattTransport, type NobleAdapter } from "../noble-transport.js";
import { EventEmitter } from "node:events";
import { PlatformFocusedInput, type ProcessInvocation } from "../focused-input.js";
import { LinuxFocusedInput, type LinuxInvocation } from "../linux-focused-input.js";
import { TerminalSessionAdapter, type TerminalInvocation } from "../terminal-session.js";
import { LinuxHidFallback } from "../linux-hid-fallback.js";
import { desktopEnvironment, desktopLifecyclePlan } from "../desktop-lifecycle.js";

const fixture = async (name: string): Promise<Record<string, any>> => {
  const path = new URL(`../../../contracts/v1/${name}`, import.meta.url);
  const data: Record<string, any> = JSON.parse(await readFile(path, "utf8"));
  assert.equal(data.version, 1);
  return data;
};

test("config normalization conforms to v1", async () => {
  const data = await fixture("config-normalization.json");
  assert.deepEqual(configToWire(normalizeConfig(data.input)), data.expected);
});

test("status and sessions payloads conform to v1", async () => {
  const status = await fixture("status-payload.json");
  assert.deepEqual(statusToWire(status.input), status.expected);
  const sessions = await fixture("sessions-payload.json");
  assert.deepEqual(sessionsToWire(sessions.input), sessions.expected);
});

test("voice routing conforms to v1", async () => {
  const data = await fixture("voice-routing.json");
  let route: AudioRoute = data.initial_route;
  for (const event of data.events) {
    const result = transition(route, event.command, event.mode);
    assert.deepEqual({ route: result.route, actions: result.actions, audio_destination: result.route }, event.expected);
    route = result.route;
  }
});

test("HID reports conform to v1", async () => {
  const data = await fixture("hid-reports.json");
  for (const report of data.reports) {
    assert.deepEqual(keycodesFromReport(Buffer.from(report.hex, "hex")), report.expected_keycodes, report.name);
  }
});

test("session selection mirrors device command semantics", () => {
  const selection = new SessionSelection(
    [{ id: "codex" }, { id: "opencode" }, { id: "hidden", hidden: true }],
    [{ id: "codex-a", tool: "codex", state: "idle" }, { id: "codex-b", tool: "codex", state: "running" }, { id: "open-a", tool: "opencode", state: "idle" }],
  );
  assert.equal(selection.activeId, "codex-a");
  assert.equal(selection.apply({ cmd: "session.next" }), true);
  assert.equal(selection.activeId, "codex-b");
  assert.equal(selection.apply({ cmd: "tool.next" }), true);
  assert.deepEqual([selection.selectedTool, selection.activeId], ["opencode", "open-a"]);
  assert.equal(selection.apply({ cmd: "session.select", id: "open" }), true);
  assert.equal(selection.apply({ cmd: "tool.select", id: "hidden" }), false);
});

test("send queue retains FIFO order and drops its oldest item at capacity", () => {
  const queue = new SendQueue(2);
  assert.equal(queue.enqueue({ sessionId: "a", text: "one" }), undefined);
  assert.equal(queue.enqueue({ sessionId: "a", text: "two" }), undefined);
  assert.deepEqual(queue.enqueue({ sessionId: "a", text: "three" }), { sessionId: "a", text: "one" });
  assert.deepEqual(queue.drain("running"), []);
  assert.deepEqual(queue.drain("idle"), [{ sessionId: "a", text: "two" }, { sessionId: "a", text: "three" }]);
});

test("domain store derives ready/running tool states and selected payloads", () => {
  const store = new HostSessionStore(normalizeConfig({ tools: [
    { id: "claude-code", name: "Claude", bindings: { enter: "Enter" } },
    { id: "codex", name: "Codex", bindings: { cancel: "Escape" } },
  ] }));
  store.replace([
    { id: "claude-1", status: { tool: "claude-code", model: "", session: "Fix BLE", state: "running", ctx_pct: -1, cost_usd: -1, last: "", updated: 20 } },
    { id: "codex-1", status: { tool: "codex", model: "", session: "Package", state: "idle", ctx_pct: -1, cost_usd: -1, last: "", updated: 10 } },
  ]);
  assert.deepEqual(store.toolsPayload().list.map((tool) => [tool.id, tool.state]), [["claude-code", "running"], ["codex", "ready"]]);
  assert.equal(store.statusPayload().session, "Fix BLE");
  store.apply({ cmd: "tool.next" });
  assert.deepEqual(store.sessionsPayload().list.map((session) => session.id), ["codex-1"]);
  assert.deepEqual(store.toolsPayload().list[1]?.fns, ["status", "sessions", "voice"]);
});

test("session store selects the next discovered session after a successful session.new request", () => {
  const store = new HostSessionStore(normalizeConfig({ tools: [{ id: "codex", name: "Codex" }] }));
  const status = (id: string, updated: number) => ({ id, status: { tool: "codex", model: "", session: id, state: "idle", ctx_pct: -1, cost_usd: -1, last: "", updated } });
  store.replace([status("old", 1)]); store.requestNewSession();
  store.replace([status("new", 2), status("old", 1)]);
  assert.equal(store.activeId, "new");
});

test("process discovery supplements adapter sessions without duplicating their pids", () => {
  const config = normalizeConfig({ tools: [{ id: "codex", name: "Codex", process: "codex", aliases: ["codex-cli"] }, { id: "hidden", name: "Hidden", hidden: true, process: "hidden" }] });
  const live = discoverProcessSessions(config, [{ pid: 12, name: "/usr/bin/codex", tty: "pts/4" }, { pid: 13, name: "codex-cli" }, { pid: 14, name: "hidden" }], 100);
  assert.deepEqual(live.map((record) => [record.id, record.raw?.tty]), [["process-codex-12", "/dev/pts/4"], ["process-codex-13", undefined]]);
  const files = [{ id: "adapter", raw: { pid: 12 }, status: { tool: "codex", model: "", session: "Adapter", state: "idle", ctx_pct: -1, cost_usd: -1, last: "", updated: 1 } }];
  assert.deepEqual(mergeSessions(files, live).map((record) => record.id), ["adapter", "process-codex-13"]);
});

test("dashboard contract returns snapshots and routes commands through one core", () => {
  const core = new HostCore(normalizeConfig({ tools: [{ id: "codex", name: "Codex" }] }));
  core.replaceSessions([{ id: "c1", status: { tool: "codex", model: "", session: "Work", state: "idle", ctx_pct: -1, cost_usd: -1, last: "", updated: 1 } }]);
  assert.equal((dashboardRequest(core, "GET", "/api/status").body as { selected_tool: string }).selected_tool, "codex");
  const mic = dashboardRequest(core, "POST", "/api/command", { cmd: "voice.start", mode: "mic" });
  const micBody = mic.body as { actions: string[]; audio_route: string };
  assert.deepEqual([mic.status, micBody.actions, micBody.audio_route], [200, ["relay.start"], "mic"]);
  assert.equal(dashboardRequest(core, "POST", "/api/command", { cmd: "tool.select", id: "nope" }).status, 400);
  const desktop = dashboardRequest(core, "GET", "/api/desktop", undefined, {
    implementation: "host-2", owner: "active", runtime: "ready",
    capabilities: { ble: { available: true }, keyboard: { available: true }, mic: { available: true }, asr: { available: true } },
    traditional_owner: { state: "unavailable" },
    config: { path: "/tmp/config.json", asr_engine: "online", asr_api_base: "https://api.example.test/v1", asr_model: "whisper", online_asr_configured: true, session_launcher: "auto", tools: [] },
  });
  assert.equal((desktop.body as { environment: { owner: string } }).environment.owner, "active");
  const preview = dashboardRequest(core, "GET", "/api/desktop").body as { environment: { capabilities: { yolo?: { available: boolean } } } };
  assert.equal(preview.environment.capabilities.yolo?.available, false);
});

test("traditional Python owner probe is read-only and distinguishes connected state", async () => {
  const connected = await probeTraditionalOwner(async () => new Response(JSON.stringify({ connected: true }), { status: 200 }));
  assert.deepEqual(connected, { state: "running", detail: "Python 1.x is connected to the Stick." });
  const idle = await probeTraditionalOwner(async () => new Response(JSON.stringify({ connected: false }), { status: 200 }));
  assert.equal(idle.state, "running");
  const unavailable = await probeTraditionalOwner(async () => { throw new Error("refused"); });
  assert.deepEqual(unavailable, { state: "unavailable" });
});

test("diagnostics export is useful while redacting secrets, paths, and conversation content", () => {
  const core = new HostCore(normalizeConfig({ tools: [{ id: "codex", name: "Sensitive session", cwd: "/private/project", command: "codex --danger" }], asr: { online: { api_key: "do-not-export" } } }));
  core.replaceSessions([{ id: "private-id", status: { tool: "codex", model: "", session: "Top secret", state: "running", ctx_pct: -1, cost_usd: -1, last: "private transcript", updated: 1 } }]);
  const report = diagnosticsReport(core, {
    implementation: "host-2", owner: "active", runtime: "ready", traditional_owner: { state: "unavailable" },
    capabilities: { ble: { available: true }, keyboard: { available: true }, mic: { available: false, reason: "missing" }, asr: { available: true } },
    config: { path: "/private/config.json", asr_engine: "online", asr_api_base: "https://example.test", asr_model: "whisper", online_asr_configured: true, session_launcher: "auto", tools: [{ id: "codex", name: "Codex", cwd: "/private/project" }] },
  }, { platform: "linux", arch: "x64", runtime: "node test" });
  const text = JSON.stringify(report);
  assert.match(text, /vibestick-host-diagnostics\/v1/);
  for (const secret of ["do-not-export", "/private", "codex --danger", "Top secret", "private transcript", "Sensitive session"]) assert.equal(text.includes(secret), false);
});

test("native Noble transport discovers VibeStick, maps GATT and preserves notifications", async () => {
  class FakeCharacteristic extends EventEmitter {
    writes: Uint8Array[] = []; subscribed = false;
    constructor(readonly uuid: string) { super(); }
    async subscribeAsync() { this.subscribed = true; }
    async writeAsync(data: Buffer) { this.writes.push(new Uint8Array(data)); }
  }
  const characteristics = [BLE.status, BLE.sessions, BLE.tools, BLE.voice, BLE.input, BLE.command, BLE.audio, BLE.hidInput].map((id) => new FakeCharacteristic(id.replaceAll("-", "")));
  const peripheral = new EventEmitter() as EventEmitter & { id: string; address: string; advertisement: { localName: string; serviceUuids: string[] }; connectAsync(): Promise<void>; disconnectAsync(): Promise<void>; discoverAllServicesAndCharacteristicsAsync(): Promise<{ characteristics: FakeCharacteristic[] }> };
  Object.assign(peripheral, {
    id: "p1", address: "AA:BB:CC:DD:EE:FF", advertisement: { localName: "VibeStick", serviceUuids: [BLE.service.replaceAll("-", "")] },
    async connectAsync() {}, async disconnectAsync() {}, async discoverAllServicesAndCharacteristicsAsync() { return { characteristics }; },
  });
  const noble = new EventEmitter() as EventEmitter & NobleAdapter;
  Object.assign(noble, {
    state: "poweredOn", async startScanningAsync() { noble.emit("discover", peripheral); }, async stopScanningAsync() {},
  });
  const transport = new NobleGattTransport("", async () => noble, 100);
  const notices: string[] = [];
  transport.onNotification((kind, data) => notices.push(`${kind}:${new TextDecoder().decode(data)}`));
  await transport.connect();
  await transport.subscribe("INPUT");
  characteristics.find((item) => item.uuid === BLE.input.replaceAll("-", ""))?.emit("data", Buffer.from("hello"));
  await transport.write("STATUS", new TextEncoder().encode("status"));
  assert.equal(transport.address, "AA:BB:CC:DD:EE:FF");
  assert.deepEqual(notices, ["INPUT:hello"]);
  assert.equal(characteristics.find((item) => item.uuid === BLE.status.replaceAll("-", ""))?.writes[0] && new TextDecoder().decode(characteristics.find((item) => item.uuid === BLE.status.replaceAll("-", ""))!.writes[0]), "status");
  await transport.disconnect();
});

test("cross-platform YOLO focused input uses safe argv/environment boundaries", async () => {
  const calls: ProcessInvocation[] = [];
  const runner = async (input: ProcessInvocation): Promise<boolean> => { calls.push(input); return true; };
  const mac = new PlatformFocusedInput("darwin", runner);
  assert.equal(await mac.text('hi "quoted"\nnext'), true);
  assert.equal(await mac.enter(), true);
  assert.equal(await mac.escapeTwice(), true);
  assert.match(calls[0]?.args[1] ?? "", /keystroke "hi \\"quoted\\" next"/);
  assert.equal(calls.filter((item) => item.command === "osascript").length, 4);
  calls.length = 0;
  assert.equal(await mac.probe(), true);
  assert.match(calls[0]?.args[1] ?? "", /frontmost/);
  assert.equal(calls[0]?.env, undefined);
  calls.length = 0;
  const windows = new PlatformFocusedInput("win32", runner);
  await windows.text("你好 & not shell"); await windows.enter(); await windows.escapeTwice();
  assert.equal(calls.every((item) => item.command === "powershell.exe" && item.args.includes("-EncodedCommand")), true);
  assert.equal(calls.some((item) => item.args.join(" ").includes("你好")), false);
  const textCall = calls[0] as ProcessInvocation | undefined;
  assert.equal(Buffer.from(textCall?.env?.VIBESTICK_INPUT_TEXT_B64 ?? "", "base64").toString("utf8"), "你好 & not shell");
  calls.length = 0;
  assert.equal(await windows.probe(), true);
  assert.equal(calls[0]?.command, "powershell.exe");
  assert.equal(calls[0]?.env, undefined);
  const linux = new PlatformFocusedInput("linux", runner);
  assert.equal(await linux.text("no"), false);
});

test("Linux native YOLO focused input probes then uses ydotool or wtype argv", async () => {
  const calls: LinuxInvocation[] = [];
  const ydotool = new LinuxFocusedInput(async (input) => { calls.push(input); return input.command === "ydotool"; });
  assert.equal(await ydotool.probe(), true);
  assert.equal(await ydotool.text("你好; no shell"), true);
  assert.equal(await ydotool.enter(), true);
  assert.equal(await ydotool.escapeTwice(), true);
  assert.deepEqual(calls, [
    { command: "ydotool", args: ["--help"] },
    { command: "ydotool", args: ["type", "--", "你好; no shell"] },
    { command: "ydotool", args: ["key", "28:1"] },
    { command: "ydotool", args: ["key", "1:1"] },
    { command: "ydotool", args: ["key", "1:1"] },
  ]);
  const wtypeCalls: LinuxInvocation[] = [];
  const wtype = new LinuxFocusedInput(async (input) => { wtypeCalls.push(input); return input.command === "wtype"; });
  assert.equal(await wtype.probe(), true);
  assert.equal(await wtype.escapeTwice(), true);
  assert.deepEqual(wtypeCalls, [
    { command: "ydotool", args: ["--help"] }, { command: "wtype", args: ["--help"] },
    { command: "wtype", args: ["-k", "ESC", "-k", "ESC"] },
  ]);
});

test("native terminal adapter delivers only to selected tmux or zellij sessions", async () => {
  const core = new HostCore(normalizeConfig({ tools: [{ id: "codex", name: "Codex" }] }));
  core.replaceSessions([{ id: "tmux", status: { tool: "codex", model: "", session: "Task", state: "idle", ctx_pct: -1, cost_usd: -1, last: "", updated: 1 }, fg: true, raw: { tmux: "%7" } }]);
  const calls: TerminalInvocation[] = [];
  const adapter = new TerminalSessionAdapter(core, async (input) => { calls.push(input); return true; });
  assert.equal(await adapter.deliver("continue"), true);
  assert.equal(await adapter.binding("ctrl-c"), true);
  assert.equal(await adapter.newSession({ tool: "codex", name: "Codex", command: "codex", cwd: "/work", launcher: "auto" }), true);
  assert.deepEqual(calls, [
    { command: "tmux", args: ["send-keys", "-t", "%7", "--", "continue", "Enter"] },
    { command: "tmux", args: ["send-keys", "-t", "%7", "--", "C-c"] },
    { command: "tmux", args: ["new-window", "-t", "%7", "-n", "Codex", "-c", "/work", "--", "codex"] },
  ]);
  core.replaceSessions([{ id: "plain", status: { tool: "codex", model: "", session: "Task", state: "idle", ctx_pct: -1, cost_usd: -1, last: "", updated: 1 }, fg: true, raw: { pid: 1 } }]);
  assert.equal(await adapter.deliver("never global"), false);
});

test("Linux HID fallback emits only F15/F14 state transitions", async () => {
  const calls: string[][] = [];
  const fallback = new LinuxHidFallback(async (_command, args) => { calls.push(args); return true; });
  assert.equal(await fallback.probe(), true);
  assert.equal(await fallback.report([185]), true);
  assert.equal(await fallback.report([185, 184]), true);
  assert.equal(await fallback.report([184]), true);
  await fallback.release();
  assert.deepEqual(calls, [["--help"], ["key", "185:1"], ["key", "184:1"], ["key", "185:0"], ["key", "184:0"]]);
});

test("online ASR settings validate provider data and never return API keys", async () => {
  const updated = updateOnlineAsr(normalizeConfig({}), { api_base: "https://api.example.test/v1", model: "whisper", api_key: "secret-key" });
  assert.equal(updated.asr.engine, "online");
  assert.deepEqual(publicAsrSettings(updated), { engine: "online", api_base: "https://api.example.test/v1", model: "whisper", configured: true });
  assert.throws(() => updateOnlineAsr(updated, { api_base: "file:///tmp", model: "x" }), /http/);
  assert.equal(updateSessionLauncher(updated, { session_launcher: "zellij" }).session_launcher, "zellij");
  assert.throws(() => updateSessionLauncher(updated, { session_launcher: "screen" }), /launcher/);
  const withTool = normalizeConfig({ tools: [{ id: "codex", name: "Codex" }] });
  assert.equal(updateToolCwd(withTool, { id: "codex", cwd: "/work" }).tools[0]?.cwd, "/work");
  const configuredTool = updateToolCwd(withTool, { id: "codex", cwd: "/work" });
  assert.equal(updateToolCwd(configuredTool, { id: "codex", cwd: "" }).tools[0]?.cwd, undefined);
  assert.throws(() => updateToolCwd(withTool, { id: "none", cwd: "/work" }), /Unknown/);
  const calls: RequestInit[] = [];
  const verification = await verifyOnlineAsr(updated, async (_url, init) => {
    calls.push(init ?? {});
    return new Response(JSON.stringify({ data: [{ id: "whisper" }] }), { status: 200 });
  });
  assert.deepEqual(verification, { provider: "reachable", model_available: true });
  assert.equal((calls[0]?.headers as { authorization?: string }).authorization, "Bearer secret-key");
  await assert.rejects(verifyOnlineAsr(normalizeConfig({ asr: { engine: "online" } })), /API key/);
});

test("loopback dashboard permits the desktop development origin and JSON commands", async () => {
  const core = new HostCore(normalizeConfig({ tools: [] }));
  const server = await startDashboardServer(core, 0);
  const response = await fetch(`http://127.0.0.1:${server.port}/api/desktop`, { headers: { origin: "http://127.0.0.1:5174" } });
  assert.equal(response.headers.get("access-control-allow-origin"), "http://127.0.0.1:5174");
  assert.equal(response.status, 200);
  await server.close();
});

test("dashboard exposes an explicit online ASR provider test without returning secrets", async () => {
  const core = new HostCore(normalizeConfig({ tools: [] }));
  const server = await startDashboardServer(core, 0, undefined, {
    async updateOnlineAsr() { return { engine: "online", api_base: "https://example.test", model: "whisper", configured: true }; },
    async testOnlineAsr() { return { provider: "reachable", model_available: null }; },
    async testYoloFocused() { return { available: true, detail: "probe passed" }; },
    async updateSessionLauncher() { return { session_launcher: "auto" }; },
    async updateToolCwd() { return { id: "", cwd: "" }; },
  });
  const response = await fetch(`http://127.0.0.1:${server.port}/api/settings/asr/test`, { method: "POST" });
  assert.deepEqual(await response.json(), { ok: true, provider: "reachable", model_available: null });
  const yolo = await fetch(`http://127.0.0.1:${server.port}/api/settings/yolo/test`, { method: "POST" });
  assert.deepEqual(await yolo.json(), { ok: true, available: true, detail: "probe passed" });
  await server.close();
});

test("dashboard capability contract exposes only explicit safe permission probes", () => {
  const core = new HostCore(normalizeConfig({ tools: [] }));
  const response = dashboardRequest(core, "GET", "/api/desktop", undefined, {
    implementation: "host-2", owner: "inactive", runtime: "degraded",
    capabilities: {
      ble: { available: false }, keyboard: { available: false }, mic: { available: false }, asr: { available: false },
      yolo: { available: false, reason: "Run the focused-input permission test in Settings", testable: true },
    },
    traditional_owner: { state: "unavailable" },
    config: { path: "", asr_engine: "online", asr_api_base: "", asr_model: "", online_asr_configured: true, session_launcher: "auto", tools: [] },
  }).body as { environment: { capabilities: { yolo?: { testable?: boolean } } } };
  assert.equal(response.environment.capabilities.yolo?.testable, true);
});

test("file repository atomically persists config and defensively loads fresh sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vibestick-ts-"));
  const configPath = join(directory, "config.json");
  const config = normalizeConfig({ tools: [{ id: "codex", name: "Codex" }] });
  await saveConfigFile(configPath, config);
  assert.deepEqual(configToWire(await loadConfigFile(configPath)), configToWire(config));
  await writeFile(join(directory, "good.json"), JSON.stringify({ id: "good", tool: "codex", session: "Task", state: "idle", updated: Math.floor(Date.now() / 1000) }));
  await writeFile(join(directory, "bad.json"), "not json");
  assert.deepEqual((await loadSessionDirectory(directory)).map((record) => record.id), ["good"]);
  assert.match(await readFile(configPath, "utf8"), /"session_launcher"/);
});

test("lifecycle plans are per-user and contain idempotent unregister operations", () => {
  const common = { executable: "/Applications/VibeStick Host", configPath: "/tmp/config.json", home: "/home/alice", uid: 501 };
  const linux = lifecyclePlan("linux", common);
  assert.match(linux.files[0]?.contents ?? "", /ExecStart=.*VibeStick\\ Host/);
  assert.deepEqual(linux.uninstall[0]?.args, ["--user", "disable", "--now", "vibestick-ts.service"]);
  const mac = lifecyclePlan("darwin", common);
  assert.match(mac.files[0]?.path ?? "", /LaunchAgents\/io\.vibestick\.host\.plist$/);
  assert.match(mac.files[0]?.contents ?? "", /RunAtLoad/);
  const windows = lifecyclePlan("win32", common);
  assert.deepEqual(windows.files, []);
  assert.deepEqual(windows.uninstall[0]?.args, ["/Delete", "/TN", "VibeStick Host", "/F"]);
  assert.deepEqual(lifecycleStatusInvocation("linux", 1000), { command: "systemctl", args: ["--user", "is-enabled", "vibestick-ts.service"] });
  assert.deepEqual(lifecycleStatusInvocation("darwin", 501), { command: "launchctl", args: ["print", "gui/501/io.vibestick.host"] });
  assert.deepEqual(lifecycleStatusInvocation("win32", 1), { command: "schtasks", args: ["/Query", "/TN", "VibeStick Host"] });
});

test("packaged lifecycle plans preserve required runtime environment on every platform", () => {
  const options = {
    executable: "/Applications/VibeStick Host", configPath: "/tmp/config.json", home: "/Users/alice", uid: 501,
    arguments: ["/Applications/VibeStick Host.app/Contents/Resources/host-core/cli.js", "--config", "/tmp/config.json"],
    environment: { ELECTRON_RUN_AS_NODE: "1" },
  };
  const linux = lifecyclePlan("linux", options);
  assert.match(linux.files[0]?.contents ?? "", /Environment="ELECTRON_RUN_AS_NODE=1"/);
  assert.match(linux.files[0]?.contents ?? "", /host-core\/cli\.js --config/);
  const mac = lifecyclePlan("darwin", options);
  assert.match(mac.files[0]?.contents ?? "", /<key>EnvironmentVariables<\/key>/);
  assert.match(mac.files[0]?.contents ?? "", /ELECTRON_RUN_AS_NODE/);
  const windows = lifecyclePlan("win32", options);
  assert.match(windows.files[0]?.path ?? "", /AppData\/Local\/VibeStick\/vibestick-ts\.cmd$/);
  assert.match(windows.files[0]?.contents ?? "", /set "ELECTRON_RUN_AS_NODE=1"/);
  assert.match(windows.install[0]?.args.join(" ") ?? "", /cmd\.exe/);
});

test("desktop login registration launches the shell and keeps only Linux session variables", () => {
  const source = { DISPLAY: ":1", WAYLAND_DISPLAY: "wayland-1", XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", SECRET: "must-not-persist" };
  assert.deepEqual(desktopEnvironment("linux", source), { DISPLAY: ":1", WAYLAND_DISPLAY: "wayland-1", XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" });
  assert.deepEqual(desktopEnvironment("darwin", source), {});
  const linux = desktopLifecyclePlan({ platform: "linux", executable: "/opt/VibeStick Host", appArguments: [], home: "/home/alice", uid: 1000, environment: source });
  assert.match(linux.files[0]?.contents ?? "", /ExecStart=\/opt\/VibeStick\\ Host/);
  assert.doesNotMatch(linux.files[0]?.contents ?? "", /must-not-persist/);
  const windows = desktopLifecyclePlan({ platform: "win32", executable: "C:\\Program Files\\VibeStick\\VibeStick Host.exe", appArguments: [], home: "C:\\Users\\Alice", uid: 1, environment: source });
  assert.equal(windows.files.length, 0);
  assert.match(windows.install[0]?.args.join(" ") ?? "", /VibeStick Host\.exe/);
});

test("lifecycle executor writes before install, removes only after a successful uninstall", async () => {
  const plan = lifecyclePlan("linux", { executable: "/opt/vibestick", configPath: "/tmp/config.json", home: "/home/alice", uid: 1 });
  const calls: string[] = [];
  const files: FileSystem = {
    async write(file) { calls.push(`write:${file.path}`); }, async remove(path) { calls.push(`remove:${path}`); },
  };
  const runner: CommandRunner = { async run(invocation) { calls.push(`run:${invocation.command}:${invocation.args.join(" ")}`); return { code: 0, stdout: "", stderr: "" }; } };
  const installed = await executeLifecycle(plan, "install", runner, files);
  assert.equal(installed.files.length, 1);
  assert.match(calls[0] ?? "", /^write:/);
  assert.match(calls[1] ?? "", /^run:systemctl:--user daemon-reload/);
  calls.length = 0;
  const removed = await executeLifecycle(plan, "uninstall", runner, files);
  assert.equal(removed.files.length, 1);
  assert.match(calls.at(-1) ?? "", /^remove:/);
});

test("lifecycle executor retains registration files when unregister fails", async () => {
  const plan = lifecyclePlan("linux", { executable: "/opt/vibestick", configPath: "/tmp/config.json", home: "/home/alice", uid: 1 });
  let removed = false;
  const files: FileSystem = { async write() {}, async remove() { removed = true; } };
  const runner: CommandRunner = { async run() { return { code: 1, stdout: "", stderr: "denied" }; } };
  await assert.rejects(executeLifecycle(plan, "uninstall", runner, files), /denied/);
  assert.equal(removed, false);
});

test("BLE bridge subscribes, syncs and keeps Vibe Mic audio separate from ASR", async () => {
  const core = new HostCore(normalizeConfig({ tools: [{ id: "codex", name: "Codex" }] }));
  const transport = new MemoryGattTransport();
  const audio: string[] = [];
  const bridge = new VibeBridge(transport, core, { onAudio: (destination) => { audio.push(destination); } });
  await bridge.connect();
  assert.deepEqual(transport.subscriptions, ["INPUT", "COMMAND", "AUDIO", "HID_INPUT"]);
  assert.deepEqual(transport.writes.map((item) => item.characteristic), ["STATUS", "SESSIONS", "TOOLS"]);
  transport.notify("COMMAND", new TextEncoder().encode('{"cmd":"voice.start","mode":"mic"}'));
  transport.notify("AUDIO", new Uint8Array([128, 129]));
  transport.notify("COMMAND", new TextEncoder().encode('{"cmd":"voice.start"}'));
  transport.notify("AUDIO", new Uint8Array([130]));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(audio, ["mic", "asr"]);
});

test("BLE bridge forwards the original HID report for the Linux uinput helper", async () => {
  const core = new HostCore(normalizeConfig({ tools: [] }));
  const transport = new MemoryGattTransport();
  let raw = "";
  const bridge = new VibeBridge(transport, core, { onHid: (keys, report) => { assert.deepEqual(keys, [185]); raw = Buffer.from(report).toString("hex"); } });
  await bridge.connect();
  transport.notify("HID_INPUT", Buffer.from("00006a0000000000", "hex"));
  assert.equal(raw, "00006a0000000000");
});

test("BLE bridge publishes TypeScript voice state and exposes commands to the voice pipeline", async () => {
  const core = new HostCore(normalizeConfig({ tools: [] }));
  const transport = new MemoryGattTransport();
  const commands: string[] = [];
  const bridge = new VibeBridge(transport, core, { onCommand: (command) => { commands.push(command.cmd); } });
  await bridge.connect();
  await bridge.publishVoice({ state: "ready", text: "send this" });
  transport.notify("COMMAND", new TextEncoder().encode('{"cmd":"voice.confirm"}'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const voice = [...transport.writes].reverse().find((item) => item.characteristic === "VOICE");
  assert.equal(new TextDecoder().decode(voice?.data), '{"state":"ready","text":"send this"}');
  assert.deepEqual(commands, ["voice.confirm"]);
});

test("BLE bridge preserves a device custom-function identifier for platform delivery", async () => {
  const core = new HostCore(normalizeConfig({ tools: [] }));
  const transport = new MemoryGattTransport();
  let received = "";
  const bridge = new VibeBridge(transport, core, { onCommand: (command) => { received = command.fn ?? ""; } });
  await bridge.connect();
  transport.notify("COMMAND", new TextEncoder().encode('{"cmd":"fn.activate","fn":"format"}'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(received, "format");
});

test("BLE bridge reports a serialized side-effect failure and continues handling later input", async () => {
  const transport = new MemoryGattTransport();
  const core = new HostCore(normalizeConfig({}));
  const errors: string[] = [];
  const bridge = new VibeBridge(transport, core, {
    onCommand: async () => { throw new Error("focused input denied"); },
    onEffectError: (error) => { errors.push(error.message); },
  });
  await bridge.connect();
  transport.notify("COMMAND", new TextEncoder().encode('{"cmd":"yolo.enter"}'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  transport.notify("COMMAND", new TextEncoder().encode('{"cmd":"yolo.escape"}'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(errors, ["focused input denied", "focused input denied"]);
});

test("runtime reports a missing Vibe Mic capability as degraded instead of ready", async () => {
  const core = new HostCore(normalizeConfig({ tools: [] }));
  const bridge = new VibeBridge(new MemoryGattTransport(), core);
  const runtime = new HostRuntime(bridge, {
    ble: { available: true }, keyboard: { available: true }, mic: { available: false, reason: "driver missing" }, asr: { available: true },
  });
  assert.equal(await runtime.start(), "degraded");
  assert.equal(runtime.isBleOwner(), true);
  assert.deepEqual(runtime.diagnostics().capabilities.mic, { available: false, reason: "driver missing" });
  await runtime.stop();
  assert.equal(runtime.state, "stopped");
  assert.equal(runtime.isBleOwner(), false);
});

test("native TypeScript PipeWire Vibe Mic registers a source without the Python helper", async () => {
  let nodePresent = false;
  const calls: { command: string; args: string[] }[] = [];
  const sink = new PipeWireVibeMicSink(true, async (command, args) => {
    calls.push({ command, args });
    if (command === "pw-dump") return { code: 0, stdout: nodePresent ? JSON.stringify([{ id: 42, info: { props: { "node.name": "vibe-mic" } } }]) : "[]" };
    if (command === "pw-cli" && args[0] === "create-node") { nodePresent = true; return { code: 0, stdout: "" }; }
    return { code: 0, stdout: "" };
  });
  assert.equal(await sink.warmup(), true);
  assert.equal(calls.some((call) => call.command === "pw-cli" && call.args[0] === "create-node"), true);
  assert.deepEqual([...applyGain(new Uint8Array([0, 128, 255]))], [0, 128, 255]);
  assert.deepEqual([...applyGain(new Uint8Array([100, 156]), 2)], [72, 184]);
  await sink.close();
  assert.equal(calls.some((call) => call.command === "pw-cli" && call.args[0] === "destroy"), true);
});

test("runtime reports a post-connect delivery failure as degraded diagnostics", async () => {
  const core = new HostCore(normalizeConfig({ tools: [] }));
  const runtime = new HostRuntime(new VibeBridge(new MemoryGattTransport(), core), {
    ble: { available: true }, keyboard: { available: true }, mic: { available: true }, asr: { available: true },
  });
  assert.equal(await runtime.start(), "ready");
  runtime.reportError(new Error("focused injection denied"));
  assert.deepEqual(runtime.diagnostics().state, "degraded");
  assert.equal(runtime.diagnostics().error, "focused injection denied");
  await runtime.stop();
});

test("runtime reconnects an established BLE link, resyncs, and keeps one notification handler", async () => {
  const core = new HostCore(normalizeConfig({ tools: [] }));
  const transport = new MemoryGattTransport();
  const commands: string[] = [];
  let runtime: HostRuntime;
  const bridge = new VibeBridge(transport, core, {
    onConnectionState: (connected) => runtime.onBleConnectionState(connected),
    onCommand: (command) => { commands.push(command.cmd); },
  });
  runtime = new HostRuntime(bridge, {
    ble: { available: true }, keyboard: { available: true }, mic: { available: true }, asr: { available: true },
  }, 1);
  assert.equal(await runtime.start(), "ready");
  transport.drop();
  assert.equal(runtime.isBleOwner(), false);
  assert.match(runtime.diagnostics().error ?? "", /reconnecting/);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(runtime.isBleOwner(), true);
  assert.equal(runtime.state, "ready");
  assert.equal(transport.subscriptions.length, 8);
  transport.notify("COMMAND", new TextEncoder().encode('{"cmd":"yolo.enter"}'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(commands, ["yolo.enter"]);
  await runtime.stop();
});

test("runtime never claims BLE ownership when its transport connection fails", async () => {
  const core = new HostCore(normalizeConfig({ tools: [] }));
  const bridge = new VibeBridge({
    onNotification() {}, onConnectionState() {}, isConnected: () => false,
    async connect() { throw new Error("other host owns the VibeStick"); }, async disconnect() {}, async subscribe() {}, async write() {},
  }, core);
  const runtime = new HostRuntime(bridge, {
    ble: { available: true }, keyboard: { available: true }, mic: { available: true }, asr: { available: true },
  });
  assert.equal(await runtime.start(), "degraded");
  assert.equal(runtime.isBleOwner(), false);
  assert.match(runtime.diagnostics().error ?? "", /other host owns/);
});

test("runtime waits for the Python owner gate instead of probing BLE", async () => {
  const core = new HostCore(normalizeConfig({ tools: [] }));
  const transport = new MemoryGattTransport();
  let pythonOwnsBle = true;
  const runtime = new HostRuntime(new VibeBridge(transport, core), {
    ble: { available: true }, keyboard: { available: true }, mic: { available: true }, asr: { available: true },
  }, 1, async () => pythonOwnsBle ? { allowed: false, reason: "Python 1.x is connected to the Stick." } : { allowed: true, reason: "" });
  assert.equal(await runtime.start(), "degraded");
  assert.equal(transport.subscriptions.length, 0);
  assert.match(runtime.diagnostics().error ?? "", /Python 1\.x/);
  pythonOwnsBle = false;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(runtime.isBleOwner(), true);
  assert.equal(transport.subscriptions.length, 4);
  await runtime.stop();
});

test("Linux Vibe Mic sink only forwards frames during a mic route", async () => {
  const calls: string[] = [];
  const helper = { invoke: async (command: string, values: Record<string, unknown> = {}) => {
    calls.push(command + (typeof values.data === "string" ? `:${values.data}` : ""));
    return { ok: true, result: { available: true } };
  }};
  const sink = new LinuxVibeMicSink(helper);
  assert.equal(await sink.warmup(), true);
  await sink.feed(new Uint8Array([128]));
  await sink.apply(["relay.start"]);
  await sink.feed(new Uint8Array([128]));
  await sink.apply(["relay.stop"]);
  await sink.feed(new Uint8Array([128]));
  assert.deepEqual(calls, ["mic.warmup", "mic.start", "mic.feed:gA==", "mic.stop"]);
});

test("Linux command adapter keeps TS policy while delegating only safe system actions", async () => {
  const core = new HostCore(normalizeConfig({ tools: [{ id: "codex", name: "Codex" }] }));
  core.replaceSessions([{ id: "c1", raw: { tmux: "%7" }, status: { tool: "codex", model: "", session: "Work", state: "idle", ctx_pct: -1, cost_usd: -1, last: "", updated: 1 } }]);
  const calls: { command: string; values: Record<string, unknown> }[] = [];
  const adapter = new LinuxCommandAdapter({ invoke: async (command, values = {}) => {
    calls.push({ command, values }); return { ok: true, result: command === "focused.probe" ? { available: true } : { delivered: true } };
  }}, core, (error) => assert.fail(error.message));
  assert.equal(await adapter.deliver("continue"), true);
  assert.equal(await adapter.binding("escape"), true);
  assert.equal(await adapter.focusedText("global text"), true);
  assert.equal(await adapter.focusedProbe(), true);
  assert.equal(await adapter.focusedEnter(), true);
  assert.equal(await adapter.focusedEscape(), true);
  assert.equal(await adapter.newSession({ tool: "codex", name: "Codex", command: "codex", launcher: "auto" }), true);
  assert.deepEqual(calls.map((call) => call.command), ["delivery.text", "delivery.binding", "focused.text", "focused.probe", "focused.enter", "focused.escape", "session.new"]);
  assert.deepEqual(calls[0]?.values.record, { tmux: "%7" });
});

test("TypeScript voice pipeline buffers firmware PCM, publishes states, and only delivers after confirm", async () => {
  const updates: string[] = [];
  const transcriber: AsrTranscriber = { async transcribe(pcm) { assert.deepEqual([...pcm], [128, 129, 130]); return "continue implementation"; } };
  const pipeline = new VoicePipeline(normalizeConfig({}).asr, transcriber, (update) => updates.push(`${update.state}:${update.text}`));
  pipeline.start(); pipeline.feed(new Uint8Array([128, 129])); pipeline.feed(new Uint8Array([130])); await pipeline.stop();
  assert.deepEqual(updates, ["recording:", "transcribing:", "ready:continue implementation"]);
  assert.equal(pipeline.confirm(), "continue implementation");
  assert.equal(pipeline.confirm(), undefined);
});

test("TypeScript WAV encoding preserves the 8 kHz unsigned firmware format", () => {
  const encoded = wav(new Uint8Array([0, 128, 255]));
  assert.equal(Buffer.from(encoded.subarray(0, 4)).toString("ascii"), "RIFF");
  assert.equal(new DataView(encoded.buffer).getUint32(24, true), 8000);
  assert.equal(new DataView(encoded.buffer).getUint16(34, true), 8);
  assert.deepEqual([...encoded.subarray(44)], [0, 128, 255]);
});

test("local ASR model adapter preserves the 1.x faster-whisper configuration", async () => {
  let received: { executable: string; helper: string; bytes: number; engine: string; model: string; device: string; language: string | null } | undefined;
  const transcriber = pythonLocalTranscriber("/venv/bin/python", "/repo/host/tools/asr_helper.py", async (request) => {
    received = {
      executable: request.executable, helper: request.helper, bytes: request.pcm.length,
      engine: request.asr.engine, model: request.asr.model, device: request.asr.device,
      language: request.asr.language,
    };
    return "本地转写";
  });
  const config = normalizeConfig({ asr: { engine: "faster-whisper", model: "small", device: "cpu", language: "zh" } });
  assert.equal(await transcriber.transcribe(new Uint8Array([4, 5, 6]), config.asr), "本地转写");
  assert.deepEqual(received, {
    executable: "/venv/bin/python", helper: "/repo/host/tools/asr_helper.py", bytes: 3,
    engine: "faster-whisper", model: "small", device: "cpu", language: "zh",
  });
});
