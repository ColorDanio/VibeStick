import type { HostCore } from "./core.js";
import { VibeBridge } from "./bridge.js";
import { HelperGattTransport } from "./helper-transport.js";
import { LinuxVibeMicSink } from "./mic-sink.js";

type Invoker = Pick<HelperGattTransport, "invoke">;

/** Linux-only system actions; HostCore remains responsible for command policy. */
export class LinuxCommandAdapter {
  constructor(private readonly helper: Invoker, private readonly core: HostCore, private readonly reportError: (error: Error) => void) {}

  async deliver(text: string): Promise<boolean> { return this.invoke("delivery.text", { record: this.core.activeSessionRaw(), text }); }
  async binding(binding: string): Promise<boolean> { return this.invoke("delivery.binding", { record: this.core.activeSessionRaw(), binding }); }
  async focusedText(text: string): Promise<boolean> { return this.invoke("focused.text", { text }); }
  async focusedEnter(): Promise<boolean> { return this.invoke("focused.enter"); }
  async focusedEscape(): Promise<boolean> { return this.invoke("focused.escape"); }

  private async invoke(command: string, values: Record<string, unknown> = {}): Promise<boolean> {
    try {
      const reply = await this.helper.invoke(command, values);
      if (reply.result?.delivered) return true;
      this.reportError(new Error(`${command} failed`)); return false;
    } catch (error) { this.reportError(error instanceof Error ? error : new Error(String(error))); return false; }
  }
}

export interface LinuxBridgeOptions {
  helperExecutable: string;
  helperArgs?: string[];
  address?: string;
  onAsrAudio?(pcm: Uint8Array): void;
  onRoutingActions?(actions: import("./routing.js").RoutingAction[]): void | Promise<void>;
  onCommand?(command: { cmd: string; id?: string; mode?: unknown }): void | Promise<void>;
  onError?(error: Error): void;
}

/** Wire Linux-specific Vibe Mic and uinput fallback into the shared bridge. */
export function createLinuxBridge(core: HostCore, options: LinuxBridgeOptions): { bridge: VibeBridge; mic: LinuxVibeMicSink; commands: LinuxCommandAdapter } {
  const transport = new HelperGattTransport(options.helperExecutable, options.helperArgs ?? [], options.address ?? "");
  const mic = new LinuxVibeMicSink(transport);
  const reportError = (error: unknown): void => options.onError?.(error instanceof Error ? error : new Error(String(error)));
  const commands = new LinuxCommandAdapter(transport, core, reportError);
  const bridge = new VibeBridge(transport, core, {
    onActions: async (actions) => { try { await mic.apply(actions); await options.onRoutingActions?.(actions); } catch (error) { reportError(error); throw error; } },
    ...(options.onCommand ? { onCommand: options.onCommand } : {}),
    onAudio: async (destination, pcm) => {
      if (destination === "mic") { try { await mic.feed(pcm); } catch (error) { reportError(error); throw error; } }
      else options.onAsrAudio?.(pcm);
    },
    onInput: (text) => { void commands.deliver(text); },
    onHid: (_keycodes, report) => { void transport.invoke("hid.report", { data: Buffer.from(report).toString("base64") }).catch(reportError); },
  });
  return { bridge, mic, commands };
}
