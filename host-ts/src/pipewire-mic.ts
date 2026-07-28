import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { RoutingAction } from "./routing.js";

export interface ProcessResult { code: number; stdout: string; }
export type ProcessRunner = (command: string, args: string[]) => Promise<ProcessResult>;
export type FeederStarter = (command: string, args: string[]) => ChildProcessWithoutNullStreams | undefined;

const nodeName = "vibe-mic";
const nodeDescription = "Vibe Mic";
const feedStream = "vibestick-mic-feed";
const createNode = [
  "create-node", "adapter",
  `{ factory.name=support.null-audio-sink node.name=${nodeName} node.description=\"${nodeDescription}\" media.class=Audio/Source/Virtual device.description=\"${nodeDescription}\" device.class=sound node.virtual=true audio.position=[ FL FR ] node.always-process=true node.suspend-on-idle=false adapter.auto-port-config={ mode=dsp monitor=true position=preserve } object.linger=true }`,
];
const feederArgs = ["--playback", "-P", `node.name=${feedStream}`, "--target", "0", "--raw", "--rate", "8000", "--format", "u8", "--channels", "1", "--channel-map", "MONO", "-"];

/** Linux PipeWire virtual source owned by the TS runtime, not the Python daemon. */
export class PipeWireVibeMicSink {
  private feeder: ChildProcessWithoutNullStreams | undefined;
  private created = false;
  private running = false;

  constructor(private readonly enabled = true, private readonly runner: ProcessRunner = run, private readonly startFeeder: FeederStarter = start) {}

  async warmup(): Promise<boolean> { return this.enabled && this.ensureNode(); }

  async apply(actions: RoutingAction[]): Promise<void> {
    for (const action of actions) {
      if (action === "relay.prepare" && !(await this.ensureNode())) throw new Error("Vibe Mic unavailable: check PipeWire");
      if (action === "relay.restore") await this.stop();
      if (action === "relay.start" && !(await this.start())) throw new Error("Vibe Mic unavailable: check PipeWire");
      if (action === "relay.stop") await this.stop();
    }
  }

  async start(): Promise<boolean> {
    if (!this.enabled) return false;
    if (this.running) return true;
    if (!(await this.ensureNode())) return false;
    const feeder = this.startFeeder("pw-cat", feederArgs);
    if (!feeder?.stdin) return false;
    this.feeder = feeder;
    feeder.once("exit", () => { if (this.feeder === feeder) { this.feeder = undefined; this.running = false; } });
    if (!(await this.linkFeeder())) { await this.stop(); return false; }
    this.running = true;
    return true;
  }

  feed(pcm: Uint8Array): void {
    if (!this.running || !this.feeder?.stdin.writable) return;
    try { this.feeder.stdin.write(Buffer.from(applyGain(pcm))); }
    catch { this.running = false; this.feeder = undefined; }
  }

  async stop(): Promise<void> {
    this.running = false;
    const feeder = this.feeder; this.feeder = undefined;
    if (!feeder || feeder.exitCode !== null) return;
    feeder.kill();
    await new Promise<void>((resolve) => { feeder.once("exit", () => resolve()); setTimeout(resolve, 3_000).unref(); });
  }

  async close(): Promise<void> {
    await this.stop();
    if (!this.created) return;
    const id = await this.nodeId();
    if (id !== undefined) await this.runner("pw-cli", ["destroy", String(id)]);
    this.created = false;
  }

  private async ensureNode(): Promise<boolean> {
    if ((await this.nodeId()) !== undefined) return true;
    const result = await this.runner("pw-cli", createNode);
    if (result.code !== 0) return false;
    this.created = true;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await this.nodeId()) !== undefined) return true;
      await delay(100);
    }
    return false;
  }

  private async nodeId(): Promise<number | undefined> {
    const result = await this.runner("pw-dump", []);
    if (result.code !== 0) return undefined;
    try {
      const nodes: unknown = JSON.parse(result.stdout);
      if (!Array.isArray(nodes)) return undefined;
      const node = nodes.find((item) => typeof item === "object" && item !== null && ((item as { info?: { props?: { "node.name"?: unknown } } }).info?.props?.["node.name"] === nodeName));
      return typeof (node as { id?: unknown } | undefined)?.id === "number" ? (node as { id: number }).id : undefined;
    } catch { return undefined; }
  }

  private async linkFeeder(): Promise<boolean> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const result = await this.runner("pw-link", ["-o"]);
      const ports = result.stdout.split("\n").map((item) => item.trim());
      if (ports.includes(`${feedStream}:output_MONO`)) {
        const left = await this.runner("pw-link", [`${feedStream}:output_MONO`, `${nodeName}:input_FL`]);
        const right = await this.runner("pw-link", [`${feedStream}:output_MONO`, `${nodeName}:input_FR`]);
        return left.code === 0 && right.code === 0;
      }
      if (ports.includes(`${feedStream}:output_FL`) && ports.includes(`${feedStream}:output_FR`)) {
        const left = await this.runner("pw-link", [`${feedStream}:output_FL`, `${nodeName}:input_FL`]);
        const right = await this.runner("pw-link", [`${feedStream}:output_FR`, `${nodeName}:input_FR`]);
        return left.code === 0 && right.code === 0;
      }
      await delay(100);
    }
    return false;
  }
}

export function applyGain(data: Uint8Array, gain = 3): Uint8Array {
  if (gain === 1) return data;
  return Uint8Array.from(data, (value) => Math.max(0, Math.min(255, Math.round(128 + (value - 128) * gain))));
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function start(command: string, args: string[]): ChildProcessWithoutNullStreams | undefined {
  try { return spawn(command, args, { stdio: "pipe", windowsHide: true }); } catch { return undefined; }
}
function run(command: string, args: string[]): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let child: ChildProcessWithoutNullStreams | undefined;
    try { child = spawn(command, args, { stdio: "pipe", windowsHide: true }); } catch { resolve({ code: 127, stdout: "" }); return; }
    let stdout = "";
    child.stdout.on("data", (data) => { stdout += String(data); });
    child.once("error", () => resolve({ code: 127, stdout }));
    child.once("close", (code) => resolve({ code: code ?? 1, stdout }));
  });
}
