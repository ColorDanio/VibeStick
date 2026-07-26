import type { Config } from "./config.js";
import { SendQueue, type PendingMessage } from "./queue.js";
import { transition, type AudioRoute, type RoutingAction } from "./routing.js";
import { HostSessionStore, type SessionRecord } from "./store.js";

export interface CoreSnapshot {
  selected_tool: string | null;
  active_session: string | null;
  audio_route: AudioRoute;
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

  constructor(readonly config: Config) { this.store = new HostSessionStore(config); }
  replaceSessions(records: SessionRecord[]): void { this.store.replace(records); }

  command(input: { cmd: string; id?: string; mode?: unknown }): { changed: boolean; actions: RoutingAction[] } {
    if (["voice.start", "voice.stop", "voice.cancel"].includes(input.cmd)) {
      const outcome = transition(this.route, input.cmd, input.mode);
      this.route = outcome.route;
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
  snapshot(): CoreSnapshot {
    return {
      selected_tool: this.store.selectedTool,
      active_session: this.store.activeId,
      audio_route: this.route,
      queued: this.queue.size,
      status: this.store.statusPayload(),
      sessions: this.store.sessionsPayload(),
      tools: this.store.toolsPayload(),
    };
  }
}
