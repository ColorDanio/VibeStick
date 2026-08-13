import { type HostCore } from "./core.js";
import { keycodesFromReport } from "./hid.js";
import { sessionsToWire, usageToWire } from "./protocol.js";
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
export interface DeviceCommand { cmd: string; id?: string; mode?: unknown; fn?: string; name?: string; model?: string; firmware?: string; screen?: unknown; selected?: unknown; recording?: unknown; battery?: unknown; rotation?: unknown; }

/** BLE protocol bridge shared by every platform adapter. */
export class VibeBridge {
  private effects: Promise<void> = Promise.resolve();
  private audioEffects: Promise<void> = Promise.resolve();
  /** Avoid waking the Stick UI for identical 1 Hz dashboard sync snapshots. */
  private lastWirePayload = new Map<string, string>();
  /** AUDIO must not reach a recorder until its matching voice.start action is complete. */
  private audioStartBarrier: Promise<void> = Promise.resolve();
  private wired = false;
  private usageUnsupported = false;
  constructor(private readonly transport: GattTransport, private readonly core: HostCore, private readonly hooks: BridgeHooks = {}) {}

  async connect(): Promise<void> {
    if (!this.wired) {
      this.wired = true;
      this.transport.onNotification((characteristic, data) => this.notification(characteristic, data));
      this.transport.onConnectionState((connected) => this.hooks.onConnectionState?.(connected));
    }
    await this.transport.connect();
    // A newly connected peripheral has no previous state, even if the host
    // snapshot is unchanged since the last link.
    this.lastWirePayload.clear();
    this.usageUnsupported = false;
    for (const characteristic of ["INPUT", "COMMAND", "AUDIO", "HID_INPUT"] as const) await this.transport.subscribe(characteristic);
    await this.sync();
  }

  async disconnect(): Promise<void> { await this.transport.disconnect(); }
  async sync(): Promise<void> {
    const snapshot = this.core.snapshot();
    await this.write("STATUS", snapshot.status);
    await this.write("SESSIONS", sessionsToWire(snapshot.sessions));
    await this.write("TOOLS", snapshot.tools);
    await this.syncUsage();
    // Firmware before v2.3 does not expose this optional characteristic.
    // Keep connection compatibility while synchronizing key bindings whenever
    // the device supports the capability.
    await this.syncDeviceConfig();
  }
  /** Write just the Vibe Mic shortcut configuration and report whether the
   * connected device accepted the GATT write. */
  async syncDeviceConfig(): Promise<boolean> {
    try {
      await this.write("DEVICE_CONFIG", { hid: { button_a: this.core.config.mic.buttonA, button_b: this.core.config.mic.buttonB } });
      return true;
    } catch {
      return false;
    }
  }
  /** Push the cached, 30-second usage snapshot when the peripheral supports
   * the optional usage characteristic. Older firmware remains usable. */
  async syncUsage(): Promise<boolean> {
    if (this.usageUnsupported) return false;
    try {
      await this.write("USAGE", usageToWire(this.core.snapshot().usage));
      return true;
    } catch {
      this.usageUnsupported = true;
      return false;
    }
  }
  async publishVoice(value: { state: string; text: string }): Promise<void> { this.core.updateVoice(value); await this.write("VOICE", value); }

  private async write(characteristic: "STATUS" | "SESSIONS" | "TOOLS" | "VOICE" | "DEVICE_CONFIG" | "USAGE", value: unknown): Promise<void> {
    const json = JSON.stringify(value);
    if (this.lastWirePayload.get(characteristic) === json) return;
    await this.transport.write(characteristic, new TextEncoder().encode(json));
    this.lastWirePayload.set(characteristic, json);
  }

  private notification(characteristic: Characteristic, data: Uint8Array): void {
    if (characteristic === "AUDIO") {
      this.core.observeAudio(data);
      const destination = this.core.snapshot().audio_route;
      // Do not put every PCM frame on the control queue. During a recording
      // that queue can contain hundreds of frames, which used to postpone
      // voice.stop (and its Transcribing state) for an observable interval.
      // A per-recording barrier still preserves start -> first frame ordering.
      const barrier = this.audioStartBarrier;
      this.audioEffects = this.audioEffects.catch(() => undefined).then(async () => {
        await barrier;
        await this.hooks.onAudio?.(destination, data);
      }).catch((value: unknown) => this.reportEffectError(value));
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
      if (typeof payload.name === "string") command.name = payload.name;
      if (typeof payload.model === "string") command.model = payload.model;
      if (typeof payload.firmware === "string") command.firmware = payload.firmware;
      if ("screen" in payload) command.screen = payload.screen;
      if ("selected" in payload) command.selected = payload.selected;
      if ("recording" in payload) command.recording = payload.recording;
      if ("battery" in payload) command.battery = payload.battery;
      if ("rotation" in payload) command.rotation = payload.rotation;
      const result = this.core.command(command);
      const audioBeforeControl = command.cmd === "voice.stop" || command.cmd === "voice.cancel"
        ? this.audioEffects
        : undefined;
      this.queue(async () => {
        // Preserve every frame that arrived before stop/cancel, but do not
        // wait behind audio that arrives later in the next recording.
        if (audioBeforeControl) await audioBeforeControl;
        await this.hooks.onActions?.(result.actions);
        await this.hooks.onCommand?.(command);
        await this.sync();
      });
      if (command.cmd === "voice.start") this.audioStartBarrier = this.effects;
    }
  }

  private queue(effect: () => Promise<void>): void {
    this.effects = this.effects.catch(() => undefined).then(effect).catch((value: unknown) => this.reportEffectError(value));
  }

  private async reportEffectError(value: unknown): Promise<void> {
    const error = value instanceof Error ? value : new Error(String(value));
    await this.hooks.onEffectError?.(error);
  }
}

function parse(data: Uint8Array): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(data));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}
