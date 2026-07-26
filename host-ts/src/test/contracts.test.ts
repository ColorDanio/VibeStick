import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { configToWire, normalizeConfig } from "../config.js";
import { keycodesFromReport } from "../hid.js";
import { sessionsToWire, statusToWire } from "../protocol.js";
import { transition, type AudioRoute } from "../routing.js";
import { SendQueue } from "../queue.js";
import { SessionSelection } from "../session.js";

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
