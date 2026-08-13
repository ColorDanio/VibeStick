/** Platform BLE adapter boundary. No domain code may call a BLE library directly. */
export type Characteristic = "INPUT" | "COMMAND" | "AUDIO" | "HID_INPUT";
export type NotificationHandler = (characteristic: Characteristic, data: Uint8Array) => void;
export type ConnectionHandler = (connected: boolean) => void;

export interface GattTransport {
  readonly address?: string | undefined;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  subscribe(characteristic: Characteristic): Promise<void>;
  write(characteristic: "STATUS" | "SESSIONS" | "TOOLS" | "VOICE" | "DEVICE_CONFIG" | "USAGE", data: Uint8Array): Promise<void>;
  onNotification(handler: NotificationHandler): void;
  onConnectionState(handler: ConnectionHandler): void;
}

/** Test/development transport; production platform adapters implement GattTransport. */
export class MemoryGattTransport implements GattTransport {
  private connected = false;
  private handler: NotificationHandler | undefined;
  private connectionHandler: ConnectionHandler | undefined;
  readonly subscriptions: Characteristic[] = [];
  readonly writes: { characteristic: string; data: Uint8Array }[] = [];
  async connect(): Promise<void> { this.connected = true; this.connectionHandler?.(true); }
  async disconnect(): Promise<void> { this.connected = false; this.connectionHandler?.(false); }
  isConnected(): boolean { return this.connected; }
  async subscribe(characteristic: Characteristic): Promise<void> { this.subscriptions.push(characteristic); }
  async write(characteristic: "STATUS" | "SESSIONS" | "TOOLS" | "VOICE" | "DEVICE_CONFIG" | "USAGE", data: Uint8Array): Promise<void> { this.writes.push({ characteristic, data }); }
  onNotification(handler: NotificationHandler): void { this.handler = handler; }
  onConnectionState(handler: ConnectionHandler): void { this.connectionHandler = handler; }
  /** Simulate an unexpected link loss in contract tests. */
  drop(): void { this.connected = false; this.connectionHandler?.(false); }
  notify(characteristic: Characteristic, data: Uint8Array): void { this.handler?.(characteristic, data); }
}
