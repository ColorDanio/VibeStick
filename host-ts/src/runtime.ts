import type { VibeBridge } from "./bridge.js";

export type RuntimeState = "stopped" | "starting" | "ready" | "degraded" | "stopping";
/** A platform feature state. `testable` exposes an explicit safe readiness probe, if one exists. */
export interface Capability { available: boolean; reason?: string; testable?: boolean; }
export interface Capabilities { ble: Capability; keyboard: Capability; mic: Capability; asr: Capability; yolo?: Capability; }
export interface ConnectionPermission { allowed: boolean; reason: string; }
export type ConnectionGuard = () => Promise<ConnectionPermission>;
const allowConnection: ConnectionGuard = async () => ({ allowed: true, reason: "" });

/** Owns the host lifecycle state without hiding unavailable platform features. */
export class HostRuntime {
  state: RuntimeState = "stopped";
  lastError: string | undefined;
  private ownsBleLink = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnecting = false;
  private stopping = false;

  constructor(readonly bridge: VibeBridge, readonly capabilities: Capabilities, private readonly reconnectDelayMs = 2_000, private readonly canConnect: ConnectionGuard = allowConnection) {}

  async start(): Promise<RuntimeState> {
    if (this.state !== "stopped") return this.state;
    this.stopping = false;
    this.state = "starting";
    try {
      if (!(await this.permitted())) return this.state;
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
    this.stopping = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
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

  /** Called by a platform GATT adapter when an established BLE link changes. */
  onBleConnectionState(connected: boolean): void {
    if (this.stopping || this.state === "stopped") return;
    if (connected) {
      this.ownsBleLink = true;
      this.lastError = undefined;
      this.state = this.completeCapabilities() ? "ready" : "degraded";
      return;
    }
    this.ownsBleLink = false;
    this.lastError = "VibeStick BLE link lost; reconnecting";
    this.state = "degraded";
    this.scheduleReconnect();
  }

  /** Adapter side-effects (delivery, HID, focused input) can degrade a live runtime. */
  reportError(error: Error | string): void {
    this.lastError = typeof error === "string" ? error : error.message;
    if (this.state === "ready") this.state = "degraded";
  }

  private completeCapabilities(): boolean {
    return this.capabilities.ble.available && this.capabilities.keyboard.available && this.capabilities.mic.available && this.capabilities.asr.available;
  }

  private scheduleReconnect(): void {
    if (this.retryTimer || this.reconnecting || this.stopping) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.reconnect();
    }, this.reconnectDelayMs);
    this.retryTimer.unref?.();
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting || this.stopping || this.state === "stopped") return;
    this.reconnecting = true;
    try {
      if (!(await this.permitted())) return;
      await this.bridge.connect();
      this.ownsBleLink = true;
      this.lastError = undefined;
      this.state = this.completeCapabilities() ? "ready" : "degraded";
    } catch (error) {
      this.ownsBleLink = false;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.state = "degraded";
      this.scheduleReconnect();
    } finally {
      this.reconnecting = false;
      if (!this.ownsBleLink && !this.stopping) this.scheduleReconnect();
    }
  }

  private async permitted(): Promise<boolean> {
    try {
      const permission = await this.canConnect();
      if (permission.allowed) return true;
      this.ownsBleLink = false;
      this.lastError = permission.reason || "Another VibeStick owner is active";
      this.state = "degraded";
      this.scheduleReconnect();
      return false;
    } catch (error) {
      this.ownsBleLink = false;
      this.lastError = error instanceof Error ? `BLE owner check failed: ${error.message}` : `BLE owner check failed: ${String(error)}`;
      this.state = "degraded";
      this.scheduleReconnect();
      return false;
    }
  }
}
