import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configToWire, normalizeConfig } from "../config.js";
import { keycodesFromReport } from "../hid.js";
import { sessionsToWire, statusToWire } from "../protocol.js";
import { transition, type AudioRoute } from "../routing.js";
import { SendQueue } from "../queue.js";
import { SessionSelection } from "../session.js";
import { HostSessionStore } from "../store.js";
import { HostCore } from "../core.js";
import { dashboardRequest } from "../dashboard.js";
import { loadConfigFile, loadSessionDirectory, saveConfigFile } from "../files.js";
import { lifecyclePlan } from "../lifecycle.js";
import { executeLifecycle, type CommandRunner, type FileSystem } from "../lifecycle-runner.js";
import { VibeBridge } from "../bridge.js";
import { MemoryGattTransport } from "../transport.js";
import { HostRuntime } from "../runtime.js";
import { LinuxCommandAdapter } from "../linux-bridge.js";
import { LinuxVibeMicSink } from "../mic-sink.js";
import { startDashboardServer } from "../server.js";
import { VoicePipeline, wav, type AsrTranscriber } from "../asr.js";
import { discoverProcessSessions, mergeSessions } from "../process-discovery.js";
import { publicAsrSettings, updateOnlineAsr } from "../settings.js";

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
    config: { path: "/tmp/config.json", asr_engine: "online", asr_api_base: "https://api.example.test/v1", asr_model: "whisper", online_asr_configured: true },
  });
  assert.equal((desktop.body as { environment: { owner: string } }).environment.owner, "active");
});

test("online ASR settings validate provider data and never return API keys", () => {
  const updated = updateOnlineAsr(normalizeConfig({}), { api_base: "https://api.example.test/v1", model: "whisper", api_key: "secret-key" });
  assert.equal(updated.asr.engine, "online");
  assert.deepEqual(publicAsrSettings(updated), { engine: "online", api_base: "https://api.example.test/v1", model: "whisper", configured: true });
  assert.throws(() => updateOnlineAsr(updated, { api_base: "file:///tmp", model: "x" }), /http/);
});

test("loopback dashboard permits the desktop development origin and JSON commands", async () => {
  const core = new HostCore(normalizeConfig({ tools: [] }));
  const server = await startDashboardServer(core, 0);
  const response = await fetch(`http://127.0.0.1:${server.port}/api/desktop`, { headers: { origin: "http://127.0.0.1:5174" } });
  assert.equal(response.headers.get("access-control-allow-origin"), "http://127.0.0.1:5174");
  assert.equal(response.status, 200);
  await server.close();
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

test("runtime never claims BLE ownership when its transport connection fails", async () => {
  const core = new HostCore(normalizeConfig({ tools: [] }));
  const bridge = new VibeBridge({
    onNotification() {}, isConnected: () => false,
    async connect() { throw new Error("other host owns the VibeStick"); }, async disconnect() {}, async subscribe() {}, async write() {},
  }, core);
  const runtime = new HostRuntime(bridge, {
    ble: { available: true }, keyboard: { available: true }, mic: { available: true }, asr: { available: true },
  });
  assert.equal(await runtime.start(), "degraded");
  assert.equal(runtime.isBleOwner(), false);
  assert.match(runtime.diagnostics().error ?? "", /other host owns/);
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
    calls.push({ command, values }); return { ok: true, result: { delivered: true } };
  }}, core, (error) => assert.fail(error.message));
  assert.equal(await adapter.deliver("continue"), true);
  assert.equal(await adapter.binding("escape"), true);
  assert.equal(await adapter.focusedText("global text"), true);
  assert.equal(await adapter.focusedEnter(), true);
  assert.equal(await adapter.focusedEscape(), true);
  assert.equal(await adapter.newSession({ tool: "codex", name: "Codex", command: "codex", launcher: "auto" }), true);
  assert.deepEqual(calls.map((call) => call.command), ["delivery.text", "delivery.binding", "focused.text", "focused.enter", "focused.escape", "session.new"]);
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
