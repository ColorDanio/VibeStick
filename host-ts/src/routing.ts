export type AudioRoute = "asr" | "mic";
export type RoutingAction = "relay.prepare" | "relay.restore" | "relay.start" | "relay.stop" | "asr.start" | "asr.stop" | "asr.cancel";
export interface RouteTransition { route: AudioRoute; actions: RoutingAction[]; }

/** Product-level Vibe Mic versus Agent CLI audio routing contract. */
export function transition(route: AudioRoute, command: string, mode?: unknown): RouteTransition {
  if (command === "voice.start") {
    if (mode === "mic") return { route: "mic", actions: ["relay.start"] };
    return { route: "asr", actions: route === "mic" ? ["relay.stop", "asr.start"] : ["asr.start"] };
  }
  if (command === "voice.stop") return route === "mic"
    ? { route: "asr", actions: ["relay.stop"] }
    : { route: "asr", actions: ["asr.stop"] };
  if (command === "voice.cancel") return route === "mic"
    ? { route: "asr", actions: ["asr.cancel", "relay.stop"] }
    : { route: "asr", actions: ["asr.cancel"] };
  return { route, actions: [] };
}
