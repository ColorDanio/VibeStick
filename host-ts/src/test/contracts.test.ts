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
import { VibeBridge } from "../bridge.js";
import { MemoryGattTransport } from "../transport.js";
import { HostRuntime } from "../runtime.js";

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

test("dashboard contract returns snapshots and routes commands through one core", () => {
  const core = new HostCore(normalizeConfig({ tools: [{ id: "codex", name: "Codex" }] }));
  core.replaceSessions([{ id: "c1", status: { tool: "codex", model: "", session: "Work", state: "idle", ctx_pct: -1, cost_usd: -1, last: "", updated: 1 } }]);
  assert.equal((dashboardRequest(core, "GET", "/api/status").body as { selected_tool: string }).selected_tool, "codex");
  const mic = dashboardRequest(core, "POST", "/api/command", { cmd: "voice.start", mode: "mic" });
  const micBody = mic.body as { actions: string[]; audio_route: string };
  assert.deepEqual([mic.status, micBody.actions, micBody.audio_route], [200, ["relay.start"], "mic"]);
  assert.equal(dashboardRequest(core, "POST", "/api/command", { cmd: "tool.select", id: "nope" }).status, 400);
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

test("BLE bridge subscribes, syncs and keeps Vibe Mic audio separate from ASR", async () => {
  const core = new HostCore(normalizeConfig({ tools: [{ id: "codex", name: "Codex" }] }));
  const transport = new MemoryGattTransport();
  const audio: string[] = [];
  const bridge = new VibeBridge(transport, core, { onAudio: (destination) => audio.push(destination) });
  await bridge.connect();
  assert.deepEqual(transport.subscriptions, ["INPUT", "COMMAND", "AUDIO", "HID_INPUT"]);
  assert.deepEqual(transport.writes.map((item) => item.characteristic), ["STATUS", "SESSIONS", "TOOLS"]);
  transport.notify("COMMAND", new TextEncoder().encode('{"cmd":"voice.start","mode":"mic"}'));
  transport.notify("AUDIO", new Uint8Array([128, 129]));
  transport.notify("COMMAND", new TextEncoder().encode('{"cmd":"voice.start"}'));
  transport.notify("AUDIO", new Uint8Array([130]));
  assert.deepEqual(audio, ["mic", "asr"]);
});

test("runtime reports a missing Vibe Mic capability as degraded instead of ready", async () => {
  const core = new HostCore(normalizeConfig({ tools: [] }));
  const bridge = new VibeBridge(new MemoryGattTransport(), core);
  const runtime = new HostRuntime(bridge, {
    ble: { available: true }, keyboard: { available: true }, mic: { available: false, reason: "driver missing" },
  });
  assert.equal(await runtime.start(), "degraded");
  assert.deepEqual(runtime.diagnostics().capabilities.mic, { available: false, reason: "driver missing" });
  await runtime.stop();
  assert.equal(runtime.state, "stopped");
});
