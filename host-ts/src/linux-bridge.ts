import type { HostCore } from "./core.js";
import { VibeBridge } from "./bridge.js";
import { HelperGattTransport } from "./helper-transport.js";
import { LinuxVibeMicSink } from "./mic-sink.js";

export interface LinuxBridgeOptions {
  helperExecutable: string;
  helperArgs?: string[];
  address?: string;
  onAsrAudio?(pcm: Uint8Array): void;
  onError?(error: Error): void;
}

/** Wire Linux-specific Vibe Mic and uinput fallback into the shared bridge. */
export function createLinuxBridge(core: HostCore, options: LinuxBridgeOptions): { bridge: VibeBridge; mic: LinuxVibeMicSink } {
  const transport = new HelperGattTransport(options.helperExecutable, options.helperArgs ?? [], options.address ?? "");
  const mic = new LinuxVibeMicSink(transport);
  const reportError = (error: unknown): void => options.onError?.(error instanceof Error ? error : new Error(String(error)));
  const bridge = new VibeBridge(transport, core, {
    onActions: async (actions) => { try { await mic.apply(actions); } catch (error) { reportError(error); throw error; } },
    onAudio: async (destination, pcm) => {
      if (destination === "mic") { try { await mic.feed(pcm); } catch (error) { reportError(error); throw error; } }
      else options.onAsrAudio?.(pcm);
    },
    onInput: (text) => { const record = core.activeSessionRaw(); void transport.invoke("delivery.text", { record, text }).then((reply) => { if (!reply.result?.delivered) reportError(new Error("delivery failed")); }).catch(reportError); },
    onHid: (_keycodes, report) => { void transport.invoke("hid.report", { data: Buffer.from(report).toString("base64") }).catch(reportError); },
  });
  return { bridge, mic };
}
