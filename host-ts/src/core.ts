import type { Config } from "./config.js";
import { SendQueue, type PendingMessage } from "./queue.js";
import { transition, type AudioRoute, type RoutingAction } from "./routing.js";
import { HostSessionStore, type SessionRecord } from "./store.js";

type VoiceState = "idle" | "recording" | "transcribing" | "ready" | "error";
type VoicePreview = { state: VoiceState; mode: "agent" | "mic" | "yolo"; recorded_ms: number; level: number; text: string };
export type TransferRecord = {
  at: number;
  kind: "recording" | "transcript" | "delivery" | "audio" | "error";
  text: string;
};
export type TranscriptionRecord = {
  at: number;
  source: "agent" | "yolo";
  text: string;
};

export interface CoreSnapshot {
  selected_tool: string | null;
  active_session: string | null;
  audio_route: AudioRoute;
  device_mode: "home" | "agent" | "mic" | "yolo";
  device: { name?: string; model: string; firmware: string };
  foreground_target?: { app: string };
  voice: VoicePreview;
  transcriptions: TranscriptionRecord[];
  transfers: TransferRecord[];
  queued: number;
  status: ReturnType<HostSessionStore["statusPayload"]>;
  sessions: ReturnType<HostSessionStore["sessionsPayload"]>;
  tools: ReturnType<HostSessionStore["toolsPayload"]>;
}

/**
 * Platform-neutral host orchestration. Adapters own real BLE/ASR/delivery;
 * this core validates commands and reports the side effects they must perform.
 */
export class HostCore {
  readonly store: HostSessionStore;
  readonly queue = new SendQueue();
  private route: AudioRoute = "asr";
  private deviceMode: "home" | "agent" | "mic" | "yolo" = "home";
  private voice: VoicePreview = { state: "idle", mode: "agent", recorded_ms: 0, level: 0, text: "" };
  private transfers: TransferRecord[] = [];
  private transcriptions: TranscriptionRecord[] = [];
  private foregroundTarget: { app: string } | undefined;
  private device = { name: "", model: "", firmware: "" };
  private onTranscription: ((record: TranscriptionRecord) => void) | undefined;

  constructor(public config: Config) { this.store = new HostSessionStore(config); }
  /** Runtime-only settings that the BLE bridge must use before a restart. */
  updateMicConfig(mic: Config["mic"]): void { this.config = { ...this.config, mic }; }
  /** Forget transient device identity before activating a different Stick. */
  clearDevice(): void { this.device = { name: "", model: "", firmware: "" }; }
  replaceSessions(records: SessionRecord[]): void { this.store.replace(records); }

  command(input: { cmd: string; id?: string; mode?: unknown; name?: unknown; model?: unknown; firmware?: unknown }): { changed: boolean; actions: RoutingAction[] } {
    if (input.cmd === "device.info") {
      const name = typeof input.name === "string" ? input.name : "";
      const model = typeof input.model === "string" ? input.model : "";
      const firmware = typeof input.firmware === "string" ? input.firmware : "";
      const changed = name !== this.device.name || model !== this.device.model || firmware !== this.device.firmware;
      this.device = { name: name || this.device.name, model: model || this.device.model, firmware: firmware || this.device.firmware };
      return { changed, actions: [] };
    }
    if (input.cmd === "mode.select" && typeof input.mode === "string" && ["home", "agent", "mic", "yolo"].includes(input.mode)) {
      const previous = this.deviceMode;
      this.deviceMode = input.mode as typeof this.deviceMode;
      if (this.deviceMode === "mic" && previous !== "mic") return { changed: true, actions: ["relay.prepare"] };
      if (previous === "mic" && this.deviceMode !== "mic") return { changed: true, actions: ["relay.restore"] };
      return { changed: true, actions: [] };
    }
    if (["voice.start", "voice.stop", "voice.cancel"].includes(input.cmd)) {
      const outcome = transition(this.route, input.cmd, input.mode);
      this.route = outcome.route;
      if (input.cmd === "voice.start") {
        this.voice = { state: "recording", mode: input.mode === "mic" ? "mic" : input.mode === "yolo" ? "yolo" : "agent", recorded_ms: 0, level: 0, text: "" };
        this.record("recording", `${this.modeLabel(this.voice.mode)} recording started`);
      }
      if (input.cmd === "voice.stop") {
        this.voice = { ...this.voice, state: this.voice.mode === "mic" ? "idle" : "transcribing", level: 0 };
        if (this.voice.mode === "mic") this.record("audio", "Raw audio sent to Vibe Mic");
      }
      if (input.cmd === "voice.cancel") this.voice = { ...this.voice, state: "idle", level: 0, text: "" };
      return { changed: true, actions: outcome.actions };
    }
    return { changed: this.store.apply(input), actions: [] };
  }

  queueMessage(text: string): PendingMessage | undefined {
    const active = this.store.activeId;
    if (!active || !text) return undefined;
    return this.queue.enqueue({ sessionId: active, text });
  }

  drainQueued(): PendingMessage[] { return this.queue.drain(this.store.statusPayload().state); }
  activeSessionRaw(): Record<string, unknown> | undefined { return this.store.activeRaw(); }
  recordDelivery(mode: VoicePreview["mode"]): void {
    this.record("delivery", `Delivered to ${this.modeLabel(mode)}`);
  }
  setForegroundTarget(target: { app: string } | undefined): void { this.foregroundTarget = target; }
  setTranscriptionHistory(records: TranscriptionRecord[]): void { this.transcriptions = records.slice(0, 100); }
  onTranscript(listener: (record: TranscriptionRecord) => void): void { this.onTranscription = listener; }
  updateVoice(update: { state: string; text: string }): void {
    if (["idle", "recording", "transcribing", "ready", "error"].includes(update.state)) {
      this.voice = { ...this.voice, state: update.state as VoiceState, level: update.state === "recording" ? this.voice.level : 0, text: update.text };
      if (update.state === "ready" && update.text) {
        this.record("transcript", update.text);
        const source = this.voice.mode === "yolo" ? "yolo" : "agent";
        const record = { at: Date.now(), source, text: update.text } satisfies TranscriptionRecord;
        this.transcriptions = [record, ...this.transcriptions].slice(0, 100);
        this.onTranscription?.(record);
      }
      if (update.state === "error" && update.text) this.record("error", update.text);
    }
  }
  observeAudio(frame: Uint8Array): void {
    if (this.voice.state !== "recording" || !frame.length) return;
    let peak = 0;
    for (const sample of frame) peak = Math.max(peak, Math.abs(sample - 128));
    this.voice = { ...this.voice, recorded_ms: this.voice.recorded_ms + Math.round(frame.length / 8), level: Math.min(1, Math.round((peak / 127) * 100) / 100) };
  }
  snapshot(): CoreSnapshot {
    return {
      selected_tool: this.store.selectedTool,
      active_session: this.store.activeId,
      audio_route: this.route,
      device_mode: this.deviceMode,
      device: { ...(this.device.name ? { name: this.device.name } : {}), model: this.device.model, firmware: this.device.firmware },
      ...(this.foregroundTarget ? { foreground_target: { ...this.foregroundTarget } } : {}),
      voice: { ...this.voice },
      transcriptions: this.transcriptions.map((item) => ({ ...item })),
      transfers: this.transfers.map((item) => ({ ...item })),
      queued: this.queue.size,
      status: this.store.statusPayload(),
      sessions: this.store.sessionsPayload(),
      tools: this.store.toolsPayload(),
    };
  }

  private record(kind: TransferRecord["kind"], text: string): void {
    this.transfers = [{ at: Date.now(), kind, text }, ...this.transfers].slice(0, 10);
  }

  private modeLabel(mode: VoicePreview["mode"]): string {
    return mode === "mic" ? "Vibe Mic" : mode === "yolo" ? "YOLO" : "Agent CLI";
  }
}
