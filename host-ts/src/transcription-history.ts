import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TranscriptionRecord } from "./core.js";

/** Small append-only transcript history. Audio is never persisted here. */
export class TranscriptionHistory {
  constructor(private readonly path: string) {}

  async load(): Promise<TranscriptionRecord[]> {
    try {
      const contents = await readFile(this.path, "utf8");
      return contents.split("\n").flatMap((line) => {
        try {
          const value: unknown = JSON.parse(line);
          return isRecord(value) && typeof value.at === "number" && typeof value.text === "string" && isSource(value.source)
            ? [{ at: value.at, text: value.text, source: value.source }]
            : [];
        } catch { return []; }
      }).slice(-100).reverse();
    } catch { return []; }
  }

  async append(record: TranscriptionRecord): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isSource(value: unknown): value is TranscriptionRecord["source"] {
  return value === "agent" || value === "yolo";
}
