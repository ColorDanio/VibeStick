import type { VibeBridge } from "./bridge.js";

export type RuntimeState = "stopped" | "starting" | "ready" | "degraded" | "stopping";
export interface Capability { available: boolean; reason?: string; }
export interface Capabilities { ble: Capability; keyboard: Capability; mic: Capability; asr: Capability; }

/** Owns the host lifecycle state without hiding unavailable platform features. */
export class HostRuntime {
  state: RuntimeState = "stopped";
  lastError: string | undefined;
  private ownsBleLink = false;

  constructor(readonly bridge: VibeBridge, readonly capabilities: Capabilities) {}

  async start(): Promise<RuntimeState> {
    if (this.state !== "stopped") return this.state;
    this.state = "starting";
    try {
      await this.bridge.connect();
      this.ownsBleLink = true;
      this.state = this.capabilities.ble.available && this.capabilities.keyboard.available && this.capabilities.mic.available && this.capabilities.asr.available
        ? "ready" : "degraded";
    } catch (error) {
      this.ownsBleLink = false;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.state = "degraded";
    }
    return this.state;
  }

  async stop(): Promise<void> {
    if (this.state === "stopped") return;
    this.state = "stopping";
    try { await this.bridge.disconnect(); }
    finally { this.ownsBleLink = false; this.state = "stopped"; }
  }

  /** Re-evaluate probes completed after BLE connection (for example PipeWire). */
  reconcile(): RuntimeState {
    if (this.state === "ready" || this.state === "degraded") {
      this.state = this.capabilities.ble.available && this.capabilities.keyboard.available && this.capabilities.mic.available && this.capabilities.asr.available
        ? "ready" : "degraded";
    }
    return this.state;
  }

  diagnostics(): { state: RuntimeState; error?: string; capabilities: Capabilities } {
    return this.lastError ? { state: this.state, error: this.lastError, capabilities: this.capabilities }
      : { state: this.state, capabilities: this.capabilities };
  }

  /** True only after this process has connected the platform GATT transport. */
  isBleOwner(): boolean { return this.ownsBleLink; }
}
