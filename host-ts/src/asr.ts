import type { Config } from "./config.js";

export type VoiceState = "idle" | "recording" | "transcribing" | "ready" | "error";
export type VoiceUpdate = { state: VoiceState; text: string };
export interface AsrTranscriber { transcribe(pcm: Uint8Array, config: Config["asr"]): Promise<string>; }

/** Stateful 8 kHz unsigned-PCM recorder shared by every TypeScript ASR provider. */
export class VoicePipeline {
  state: VoiceState = "idle";
  private buffer = new Uint8Array(0);
  private transcript = "";

  constructor(private readonly config: Config["asr"], private readonly transcriber: AsrTranscriber, private readonly publish: (update: VoiceUpdate) => void, private readonly maxBytes = 25 * 8000) {}

  start(): void { this.buffer = new Uint8Array(0); this.transcript = ""; this.set("recording"); }
  feed(frame: Uint8Array): void {
    if (this.state !== "recording" || !frame.length) return;
    const room = this.maxBytes - this.buffer.length;
    if (room <= 0) return;
    const next = new Uint8Array(this.buffer.length + Math.min(room, frame.length));
    next.set(this.buffer); next.set(frame.subarray(0, room), this.buffer.length); this.buffer = next;
  }
  cancel(): void { this.buffer = new Uint8Array(0); this.transcript = ""; this.set("idle"); }
  confirm(): string | undefined {
    if (this.state !== "ready") return undefined;
    const text = this.transcript; this.transcript = ""; this.set("idle"); return text;
  }
  async stop(): Promise<void> {
    if (this.state !== "recording") return;
    const audio = this.buffer; this.buffer = new Uint8Array(0); this.set("transcribing");
    try {
      const text = (await this.transcriber.transcribe(audio, this.config)).trim();
      if (!text) { this.set("error", audio.length < 2400 ? "too short" : "no speech detected"); return; }
      this.transcript = text; this.set("ready", text);
    } catch (error) { this.set("error", error instanceof Error ? error.message : String(error)); }
  }
  private set(state: VoiceState, text = ""): void { this.state = state; this.publish({ state, text }); }
}

/** OpenAI-compatible transcription provider (including Groq). No permanent audio files are written. */
export const onlineTranscriber: AsrTranscriber = {
  async transcribe(pcm, config) {
    if (!config.online.api_key) throw new Error("online ASR API key is missing");
    const form = new FormData();
    form.set("model", config.online.model);
    if (config.online.language) form.set("language", config.online.language);
    const encoded = wav(pcm);
    const bytes = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer;
    form.set("file", new Blob([bytes], { type: "audio/wav" }), "vibestick.wav");
    const response = await fetch(`${config.online.api_base.replace(/\/$/, "")}/audio/transcriptions`, {
      method: "POST", headers: { authorization: `Bearer ${config.online.api_key}` }, body: form,
    });
    if (!response.ok) throw new Error(`online ASR failed (${response.status}): ${(await response.text()).slice(0, 160)}`);
    const result: unknown = await response.json();
    return typeof result === "object" && result !== null && typeof (result as { text?: unknown }).text === "string" ? (result as { text: string }).text : "";
  },
};

/** Encode firmware AUDIO payloads as a standards-compliant mono WAV without Node/native dependencies. */
export function wav(pcm: Uint8Array): Uint8Array {
  const out = new Uint8Array(44 + pcm.length); const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string): void => { for (let index = 0; index < text.length; index += 1) out[offset + index] = text.charCodeAt(index); };
  ascii(0, "RIFF"); view.setUint32(4, 36 + pcm.length, true); ascii(8, "WAVEfmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 8000, true); view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true); view.setUint16(34, 8, true); ascii(36, "data"); view.setUint32(40, pcm.length, true); out.set(pcm, 44); return out;
}
