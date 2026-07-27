import type { Config } from "./config.js";
import { SendQueue, type PendingMessage } from "./queue.js";
import { transition, type AudioRoute, type RoutingAction } from "./routing.js";
import { HostSessionStore, type SessionRecord } from "./store.js";

type VoiceState = "idle" | "recording" | "transcribing" | "ready" | "error";
type VoicePreview = { state: VoiceState; mode: "agent" | "mic" | "yolo"; recorded_ms: number; level: number; text: string };

export interface CoreSnapshot {
  selected_tool: string | null;
  active_session: string | null;
  audio_route: AudioRoute;
  device_mode: "home" | "agent" | "mic" | "yolo";
  voice: VoicePreview;
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

  constructor(readonly config: Config) { this.store = new HostSessionStore(config); }
  replaceSessions(records: SessionRecord[]): void { this.store.replace(records); }

  command(input: { cmd: string; id?: string; mode?: unknown }): { changed: boolean; actions: RoutingAction[] } {
    if (input.cmd === "mode.select" && typeof input.mode === "string" && ["home", "agent", "mic", "yolo"].includes(input.mode)) {
      this.deviceMode = input.mode as typeof this.deviceMode;
      return { changed: true, actions: [] };
    }
    if (["voice.start", "voice.stop", "voice.cancel"].includes(input.cmd)) {
      const outcome = transition(this.route, input.cmd, input.mode);
      this.route = outcome.route;
      if (input.cmd === "voice.start") this.voice = { state: "recording", mode: input.mode === "mic" ? "mic" : input.mode === "yolo" ? "yolo" : "agent", recorded_ms: 0, level: 0, text: "" };
      if (input.cmd === "voice.stop") this.voice = { ...this.voice, state: this.voice.mode === "mic" ? "idle" : "transcribing", level: 0 };
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
  updateVoice(update: { state: string; text: string }): void {
    if (["idle", "recording", "transcribing", "ready", "error"].includes(update.state)) {
      this.voice = { ...this.voice, state: update.state as VoiceState, level: update.state === "recording" ? this.voice.level : 0, text: update.text };
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
      voice: { ...this.voice },
      queued: this.queue.size,
      status: this.store.statusPayload(),
      sessions: this.store.sessionsPayload(),
      tools: this.store.toolsPayload(),
    };
  }
}
