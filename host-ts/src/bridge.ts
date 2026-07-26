import { type HostCore } from "./core.js";
import { keycodesFromReport } from "./hid.js";
import type { RoutingAction } from "./routing.js";
import type { Characteristic, GattTransport } from "./transport.js";

export interface BridgeHooks {
  onInput?(text: string): void;
  onAudio?(destination: "asr" | "mic", pcm: Uint8Array): void;
  onHid?(keycodes: number[], report: Uint8Array): void;
  onActions?(actions: RoutingAction[]): void;
}

/** BLE protocol bridge shared by every platform adapter. */
export class VibeBridge {
  constructor(private readonly transport: GattTransport, private readonly core: HostCore, private readonly hooks: BridgeHooks = {}) {}

  async connect(): Promise<void> {
    this.transport.onNotification((characteristic, data) => this.notification(characteristic, data));
    await this.transport.connect();
    for (const characteristic of ["INPUT", "COMMAND", "AUDIO", "HID_INPUT"] as const) await this.transport.subscribe(characteristic);
    await this.sync();
  }

  async disconnect(): Promise<void> { await this.transport.disconnect(); }
  async sync(): Promise<void> {
    const snapshot = this.core.snapshot();
    await this.write("STATUS", snapshot.status);
    await this.write("SESSIONS", snapshot.sessions);
    await this.write("TOOLS", snapshot.tools);
  }

  private async write(characteristic: "STATUS" | "SESSIONS" | "TOOLS" | "VOICE", value: unknown): Promise<void> {
    await this.transport.write(characteristic, new TextEncoder().encode(JSON.stringify(value)));
  }

  private notification(characteristic: Characteristic, data: Uint8Array): void {
    if (characteristic === "AUDIO") {
      this.hooks.onAudio?.(this.core.snapshot().audio_route, data);
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
      const command: { cmd: string; id?: string; mode?: unknown } = { cmd: payload.cmd };
      if (typeof payload.id === "string") command.id = payload.id;
      if ("mode" in payload) command.mode = payload.mode;
      const result = this.core.command(command);
      this.hooks.onActions?.(result.actions);
      void this.sync();
    }
  }
}

function parse(data: Uint8Array): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(data));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}
