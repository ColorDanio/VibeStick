import type { HelperGattTransport } from "./helper-transport.js";
import type { RoutingAction } from "./routing.js";

/** Linux PipeWire Vibe Mic capability delegated to the trusted BLE helper. */
export class LinuxVibeMicSink {
  private active = false;
  constructor(private readonly helper: Pick<HelperGattTransport, "invoke">) {}

  async warmup(): Promise<boolean> {
    const reply = await this.helper.invoke("mic.warmup");
    return reply.result?.available === true;
  }
  async apply(actions: RoutingAction[]): Promise<void> {
    for (const action of actions) {
      if (action === "relay.prepare") {
        const reply = await this.helper.invoke("mic.select");
        if (reply.result?.available !== true) throw new Error("Vibe Mic unavailable: check PipeWire");
      }
      if (action === "relay.restore") { await this.helper.invoke("mic.restore"); this.active = false; }
      if (action === "relay.start") {
        const reply = await this.helper.invoke("mic.start");
        this.active = reply.result?.available === true;
        if (!this.active) throw new Error("Vibe Mic unavailable: check PipeWire");
      }
      if (action === "relay.stop") { await this.helper.invoke("mic.stop"); this.active = false; }
    }
  }
  async feed(pcm: Uint8Array): Promise<void> {
    if (this.active) await this.helper.invoke("mic.feed", { data: Buffer.from(pcm).toString("base64") });
  }
}
