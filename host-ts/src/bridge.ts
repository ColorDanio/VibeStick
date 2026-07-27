import { type HostCore } from "./core.js";
import { keycodesFromReport } from "./hid.js";
import { sessionsToWire } from "./protocol.js";
import type { RoutingAction } from "./routing.js";
import type { Characteristic, GattTransport } from "./transport.js";

export interface BridgeHooks {
  onInput?(text: string): void;
  onAudio?(destination: "asr" | "mic", pcm: Uint8Array): void | Promise<void>;
  onHid?(keycodes: number[], report: Uint8Array): void;
  onActions?(actions: RoutingAction[]): void | Promise<void>;
  onCommand?(command: DeviceCommand): void | Promise<void>;
  onConnectionState?(connected: boolean): void;
  /** Surface serialized BLE side-effect failures instead of silently dropping them. */
  onEffectError?(error: Error): void | Promise<void>;
}
export interface DeviceCommand { cmd: string; id?: string; mode?: unknown; fn?: string; }

/** BLE protocol bridge shared by every platform adapter. */
export class VibeBridge {
  private effects: Promise<void> = Promise.resolve();
  private wired = false;
  constructor(private readonly transport: GattTransport, private readonly core: HostCore, private readonly hooks: BridgeHooks = {}) {}

  async connect(): Promise<void> {
    if (!this.wired) {
      this.wired = true;
      this.transport.onNotification((characteristic, data) => this.notification(characteristic, data));
      this.transport.onConnectionState((connected) => this.hooks.onConnectionState?.(connected));
    }
    await this.transport.connect();
    for (const characteristic of ["INPUT", "COMMAND", "AUDIO", "HID_INPUT"] as const) await this.transport.subscribe(characteristic);
    await this.sync();
  }

  async disconnect(): Promise<void> { await this.transport.disconnect(); }
  async sync(): Promise<void> {
    const snapshot = this.core.snapshot();
    await this.write("STATUS", snapshot.status);
    await this.write("SESSIONS", sessionsToWire(snapshot.sessions));
    await this.write("TOOLS", snapshot.tools);
  }
  async publishVoice(value: { state: string; text: string }): Promise<void> { await this.write("VOICE", value); }

  private async write(characteristic: "STATUS" | "SESSIONS" | "TOOLS" | "VOICE", value: unknown): Promise<void> {
    await this.transport.write(characteristic, new TextEncoder().encode(JSON.stringify(value)));
  }

  private notification(characteristic: Characteristic, data: Uint8Array): void {
    if (characteristic === "AUDIO") {
      const destination = this.core.snapshot().audio_route;
      // A PTT start and its first AUDIO notify can arrive back-to-back. Queue
      // frames behind relay.start/relay.stop so Vibe Mic never drops frame 1.
      this.queue(() => Promise.resolve(this.hooks.onAudio?.(destination, data)));
      return;
    }
    if (characteristic === "HID_INPUT") {
      const keycodes = keycodesFromReport(data);
      if (keycodes) this.hooks.onHid?.(keycodes, data);
      return;
    }
    const payload = parse(data);
    if (!payload) return;
    if (characteristic === "INPUT" && payload.type === "message" && typeof payload.text === "string") {
      this.hooks.onInput?.(payload.text);
      return;
    }
    if (characteristic === "COMMAND" && typeof payload.cmd === "string") {
      const command: DeviceCommand = { cmd: payload.cmd };
      if (typeof payload.id === "string") command.id = payload.id;
      if ("mode" in payload) command.mode = payload.mode;
      if (typeof payload.fn === "string") command.fn = payload.fn;
      const result = this.core.command(command);
      this.queue(async () => {
        await this.hooks.onActions?.(result.actions);
        await this.hooks.onCommand?.(command);
        await this.sync();
      });
    }
  }

  private queue(effect: () => Promise<void>): void {
    this.effects = this.effects.catch(() => undefined).then(effect).catch(async (value: unknown) => {
      const error = value instanceof Error ? value : new Error(String(value));
      await this.hooks.onEffectError?.(error);
    });
  }
}

function parse(data: Uint8Array): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(data));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}
