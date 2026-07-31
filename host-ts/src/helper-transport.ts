import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { Characteristic, ConnectionHandler, GattTransport, NotificationHandler } from "./transport.js";

export type DiscoveredStick = { name: string; address: string; rssi?: number | null; paired?: boolean; connected?: boolean };
export type HelperReply = { id?: number; ok?: boolean; result?: { address?: string; available?: boolean; delivered?: boolean; devices?: DiscoveredStick[] }; error?: string; event?: string; characteristic?: Characteristic; data?: string };

/** GattTransport backed by a signed/platform-specific JSON-lines helper. */
export class HelperGattTransport implements GattTransport {
  private child: ChildProcessWithoutNullStreams | undefined;
  private handler: NotificationHandler | undefined;
  private connectionHandler: ConnectionHandler | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (reply: HelperReply) => void; reject: (error: Error) => void }>();
  private connected = false;
  address: string | undefined;

  constructor(private readonly executable: string, private readonly args: string[] = [], private targetAddress = "") {}
  onNotification(handler: NotificationHandler): void { this.handler = handler; }
  onConnectionState(handler: ConnectionHandler): void { this.connectionHandler = handler; }
  isConnected(): boolean { return this.connected; }

  async connect(): Promise<void> {
    if (!this.child) this.start();
    const reply = await this.request({ cmd: "connect", address: this.targetAddress });
    this.address = reply.result?.address;
    this.connected = true;
    this.connectionHandler?.(true);
  }
  async disconnect(): Promise<void> {
    if (this.child && this.connected) await this.request({ cmd: "disconnect" });
    this.connected = false; this.connectionHandler?.(false);
    this.child?.kill(); this.child = undefined;
  }
  async scan(): Promise<DiscoveredStick[]> {
    if (!this.child) this.start();
    return (await this.request({ cmd: "scan" })).result?.devices ?? [];
  }
  async paired(): Promise<DiscoveredStick[]> {
    if (!this.child) this.start();
    return (await this.request({ cmd: "paired" })).result?.devices ?? [];
  }
  async pair(address: string): Promise<void> { if (!this.child) this.start(); await this.request({ cmd: "pair", address }); }
  async unpair(address: string): Promise<void> { if (!this.child) this.start(); await this.request({ cmd: "unpair", address }); }
  setTargetAddress(address: string): void { this.targetAddress = address; }
  async subscribe(_characteristic: Characteristic): Promise<void> { /* helper subscribes atomically on connect */ }
  async write(characteristic: "STATUS" | "SESSIONS" | "TOOLS" | "VOICE" | "DEVICE_CONFIG", data: Uint8Array): Promise<void> {
    await this.request({ cmd: "write", characteristic, data: Buffer.from(data).toString("base64") });
  }
  async invoke(command: string, values: Record<string, unknown> = {}): Promise<HelperReply> {
    return this.request({ cmd: command, ...values });
  }

  private start(): void {
    const child = spawn(this.executable, this.args, { stdio: "pipe" });
    this.child = child;
    createInterface({ input: child.stdout }).on("line", (line) => this.line(line));
    child.once("exit", () => { this.connected = false; this.connectionHandler?.(false); this.child = undefined; for (const item of this.pending.values()) item.reject(new Error("BLE helper exited")); this.pending.clear(); });
  }
  private request(command: Record<string, unknown>): Promise<HelperReply> {
    if (!this.child) return Promise.reject(new Error("BLE helper unavailable"));
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  private line(line: string): void {
    let reply: HelperReply; try { reply = JSON.parse(line) as HelperReply; } catch { return; }
    if (reply.event === "notify" && reply.characteristic && reply.data) this.handler?.(reply.characteristic, Buffer.from(reply.data, "base64"));
    if (reply.event === "disconnected") { this.connected = false; this.connectionHandler?.(false); }
    if (typeof reply.id === "number") {
      const pending = this.pending.get(reply.id); if (!pending) return;
      this.pending.delete(reply.id);
      reply.ok ? pending.resolve(reply) : pending.reject(new Error(reply.error ?? "BLE helper command failed"));
    }
  }
}
