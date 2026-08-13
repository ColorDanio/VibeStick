import { BLE } from "./protocol.js";
import type { Characteristic, ConnectionHandler, GattTransport, NotificationHandler } from "./transport.js";

type NobleCharacteristic = {
  uuid: string;
  on(event: "data", listener: (data: Buffer) => void): unknown;
  subscribeAsync(): Promise<void>;
  writeAsync(data: Buffer, withoutResponse: boolean): Promise<void>;
};
type NoblePeripheral = {
  id: string;
  address: string;
  advertisement: { localName?: string; serviceUuids?: string[] };
  connectAsync(): Promise<void>;
  disconnectAsync(): Promise<void>;
  discoverAllServicesAndCharacteristicsAsync(): Promise<{ characteristics: NobleCharacteristic[] }>;
  on(event: "disconnect", listener: () => void): unknown;
};
export type NobleAdapter = {
  state: string;
  on(event: "stateChange" | "discover", listener: ((state: string) => void) | ((peripheral: NoblePeripheral) => void)): unknown;
  removeListener(event: "stateChange" | "discover", listener: Function): unknown;
  startScanningAsync(serviceUuids?: string[], allowDuplicates?: boolean): Promise<void>;
  stopScanningAsync(): Promise<void>;
};
export type NobleLoader = () => Promise<NobleAdapter>;

const DEVICE_NAME = "VibeStick";
const notificationUuids: Record<Characteristic, string> = { INPUT: BLE.input, COMMAND: BLE.command, AUDIO: BLE.audio, HID_INPUT: BLE.hidInput };
const writableUuids = { STATUS: BLE.status, SESSIONS: BLE.sessions, TOOLS: BLE.tools, VOICE: BLE.voice, DEVICE_CONFIG: BLE.deviceConfig, USAGE: BLE.usage } as const;

/**
 * Cross-platform Node BLE central backed by Noble. It intentionally exposes
 * only GATT: OS-specific keyboard, audio and focused-window actions remain
 * separate capability adapters.
 */
export class NobleGattTransport implements GattTransport {
  private noble: NobleAdapter | undefined;
  private peripheral: NoblePeripheral | undefined;
  private characteristics = new Map<string, NobleCharacteristic>();
  private handler: NotificationHandler | undefined;
  private connectionHandler: ConnectionHandler | undefined;
  private connected = false;
  address: string | undefined;

  constructor(private readonly targetAddress = "", private readonly loader: NobleLoader = loadNoble, private readonly timeoutMs = 15_000) {}
  onNotification(handler: NotificationHandler): void { this.handler = handler; }
  onConnectionState(handler: ConnectionHandler): void { this.connectionHandler = handler; }
  isConnected(): boolean { return this.connected; }

  async connect(): Promise<void> {
    if (this.connected) return;
    const noble = this.noble = await this.loader();
    await waitForPoweredOn(noble, this.timeoutMs);
    const peripheral = await findDevice(noble, this.targetAddress, this.timeoutMs);
    try {
      await peripheral.connectAsync();
      const discovered = await peripheral.discoverAllServicesAndCharacteristicsAsync();
      this.characteristics = new Map(discovered.characteristics.map((item) => [uuid(item.uuid), item]));
      for (const value of [...Object.values(notificationUuids), BLE.status, BLE.sessions, BLE.tools, BLE.voice]) {
        if (!this.characteristics.has(uuid(value))) throw new Error(`VibeStick characteristic missing: ${value}`);
      }
      this.peripheral = peripheral;
      this.address = peripheral.address || peripheral.id;
      this.connected = true;
      this.connectionHandler?.(true);
      peripheral.on("disconnect", () => { this.connected = false; this.peripheral = undefined; this.characteristics.clear(); this.connectionHandler?.(false); });
    } catch (error) {
      await peripheral.disconnectAsync().catch(() => undefined);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    const peripheral = this.peripheral;
    this.connected = false; this.peripheral = undefined; this.characteristics.clear(); this.connectionHandler?.(false);
    if (peripheral) await peripheral.disconnectAsync().catch(() => undefined);
  }

  async subscribe(characteristic: Characteristic): Promise<void> {
    const item = this.require(notificationUuids[characteristic]);
    item.on("data", (data) => this.handler?.(characteristic, new Uint8Array(data)));
    await item.subscribeAsync();
  }

  async write(characteristic: keyof typeof writableUuids, data: Uint8Array): Promise<void> {
    await this.require(writableUuids[characteristic]).writeAsync(Buffer.from(data), false);
  }

  private require(value: string): NobleCharacteristic {
    const item = this.characteristics.get(uuid(value));
    if (!item || !this.connected) throw new Error(`VibeStick GATT is unavailable: ${value}`);
    return item;
  }
}

async function loadNoble(): Promise<NobleAdapter> {
  const module = await import("@abandonware/noble");
  return ("default" in module && module.default ? module.default : module) as unknown as NobleAdapter;
}

function uuid(value: string): string { return value.replaceAll("-", "").toLowerCase(); }

async function waitForPoweredOn(noble: NobleAdapter, timeoutMs: number): Promise<void> {
  if (noble.state === "poweredOn") return;
  await waitStateChange(noble, timeoutMs, (state) => {
    if (state === "poweredOn") return true;
    if (["unsupported", "unauthorized"].includes(state)) throw new Error(`Bluetooth adapter is ${state}`);
    return false;
  });
}

async function findDevice(noble: NobleAdapter, targetAddress: string, timeoutMs: number): Promise<NoblePeripheral> {
  const wantedAddress = targetAddress.replaceAll("-", ":").toLowerCase();
  return new Promise<NoblePeripheral>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result?: NoblePeripheral, error?: Error): void => {
      if (timer) clearTimeout(timer);
      noble.removeListener("discover", discovered);
      void noble.stopScanningAsync().catch(() => undefined);
      if (result) resolve(result); else reject(error ?? new Error("VibeStick was not found"));
    };
    const discovered = (peripheral: NoblePeripheral): void => {
      const address = peripheral.address.toLowerCase();
      const advertised = (peripheral.advertisement.serviceUuids ?? []).map(uuid);
      const matches = wantedAddress ? address === wantedAddress : peripheral.advertisement.localName === DEVICE_NAME || advertised.includes(uuid(BLE.service));
      if (matches) finish(peripheral);
    };
    noble.on("discover", discovered);
    timer = setTimeout(() => finish(undefined, new Error("VibeStick scan timed out")), timeoutMs);
    void noble.startScanningAsync([uuid(BLE.service)], false).catch((error: unknown) => finish(undefined, error instanceof Error ? error : new Error(String(error))));
  });
}

function waitStateChange(source: NobleAdapter, timeoutMs: number, predicate: (value: string) => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const listener = (value: string): void => {
      try {
        if (!predicate(value)) return;
        if (timer) clearTimeout(timer);
        source.removeListener("stateChange", listener); resolve();
      } catch (error) {
        if (timer) clearTimeout(timer);
        source.removeListener("stateChange", listener); reject(error);
      }
    };
    timer = setTimeout(() => { source.removeListener("stateChange", listener); reject(new Error("Bluetooth adapter did not become ready")); }, timeoutMs);
    source.on("stateChange", listener);
  });
}
