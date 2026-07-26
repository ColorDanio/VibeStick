/** FIFO send queue semantics shared with the Python daemon (capacity eight). */
export interface PendingMessage { sessionId: string; text: string; }
export class SendQueue {
  private readonly messages: PendingMessage[] = [];
  constructor(readonly maxSize = 8) {}
  get size(): number { return this.messages.length; }

  enqueue(message: PendingMessage): PendingMessage | undefined {
    const dropped = this.messages.length >= this.maxSize ? this.messages.shift() : undefined;
    this.messages.push(message);
    return dropped;
  }

  /** Drain only while the selected session is not inferring. */
  drain(selectedState: string): PendingMessage[] {
    return selectedState === "running" ? [] : this.messages.splice(0);
  }
}
