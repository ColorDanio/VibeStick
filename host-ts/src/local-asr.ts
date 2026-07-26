import { spawn } from "node:child_process";
import type { Config } from "./config.js";
import type { AsrTranscriber } from "./asr.js";

export interface LocalAsrRequest {
  executable: string;
  helper: string;
  pcm: Uint8Array;
  asr: Pick<Config["asr"], "engine" | "model" | "device" | "language" | "command">;
}
export type LocalAsrRunner = (request: LocalAsrRequest) => Promise<string>;

/**
 * Local ASR boundary for VibeConn 2.0. The host policy remains TypeScript; the
 * existing Python faster-whisper install is treated like a model driver, not a
 * second daemon or BLE owner.
 */
export function pythonLocalTranscriber(executable: string, helper: string, runner: LocalAsrRunner = runPythonLocalAsr): AsrTranscriber {
  return {
    transcribe(pcm, config) {
      if (config.engine !== "faster-whisper" && config.engine !== "command") {
        return Promise.reject(new Error(`local ASR cannot handle ${config.engine}`));
      }
      return runner({ executable, helper, pcm, asr: {
        engine: config.engine, model: config.model, device: config.device,
        language: config.language, command: config.command,
      } });
    },
  };
}

function runPythonLocalAsr(request: LocalAsrRequest): Promise<string> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(request.executable, [request.helper], { stdio: "pipe", windowsHide: true });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error))); return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill(); reject(new Error("local ASR timed out"));
    }, 180_000);
    child.stdout.on("data", (data) => { stdout += String(data); });
    child.stderr.on("data", (data) => { stderr = (stderr + String(data)).slice(-300); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      try {
        const result: unknown = JSON.parse(stdout);
        if (typeof result === "object" && result !== null && (result as { ok?: unknown }).ok === true && typeof (result as { text?: unknown }).text === "string") {
          resolve((result as { text: string }).text); return;
        }
        const detail = typeof result === "object" && result !== null && typeof (result as { error?: unknown }).error === "string"
          ? (result as { error: string }).error : stderr || `local ASR exited ${code ?? "unknown"}`;
        reject(new Error(detail));
      } catch {
        reject(new Error(stderr || `local ASR exited ${code ?? "unknown"}`));
      }
    });
    child.stdin.end(`${JSON.stringify({
      asr: request.asr, pcm: Buffer.from(request.pcm).toString("base64"),
    })}\n`);
  });
}
