import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Config } from "./config.js";
import type { AsrTranscriber } from "./asr.js";

export interface LocalAsrRequest {
  executable: string;
  helper: string;
  pcm: Uint8Array;
  asr: Pick<Config["asr"], "engine" | "model" | "device" | "language" | "command">;
}
export type LocalAsrRunner = (request: LocalAsrRequest) => Promise<string>;

export function downloadPythonLocalAsr(executable: string, helper: string, asr: LocalAsrRequest["asr"], onProgress: (progress: number) => void): Promise<void> {
  return runPythonHelper(executable, helper, { action: "download", asr }, 30 * 60_000, "local ASR model download timed out", onProgress).then(() => undefined);
}

export function applyPythonLocalAsr(executable: string, helper: string, asr: LocalAsrRequest["asr"]): Promise<void> {
  return runPythonHelper(executable, helper, { action: "apply", asr }, 5 * 60_000, "local ASR model validation timed out").then(() => undefined);
}

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
  return runPythonHelper(request.executable, request.helper, {
    asr: request.asr, pcm: Buffer.from(request.pcm).toString("base64"),
  }, 180_000, "local ASR transcription timed out").then((result) => result.text ?? "");
}

function runPythonHelper(executable: string, helper: string, body: Record<string, unknown>, timeoutMs: number, timeoutMessage: string, onProgress?: (progress: number) => void): Promise<{ text?: string }> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executable, [helper], { stdio: "pipe", windowsHide: true });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error))); return;
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill(); reject(new Error(timeoutMessage));
    }, timeoutMs);
    child.stdout.on("data", (data) => { stdout += String(data); });
    createInterface({ input: child.stderr }).on("line", (line) => {
      try {
        const event: unknown = JSON.parse(line);
        if (typeof event === "object" && event !== null && (event as { event?: unknown }).event === "progress" && typeof (event as { progress?: unknown }).progress === "number") {
          onProgress?.(Math.max(0, Math.min(100, (event as { progress: number }).progress)));
          return;
        }
      } catch { /* retain ordinary helper diagnostics below */ }
      stderr = (stderr + line + "\n").slice(-600);
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      try {
        const result: unknown = JSON.parse(stdout);
        if (typeof result === "object" && result !== null && (result as { ok?: unknown }).ok === true) {
          resolve(typeof (result as { text?: unknown }).text === "string" ? { text: (result as { text: string }).text } : {}); return;
        }
        const detail = typeof result === "object" && result !== null && typeof (result as { error?: unknown }).error === "string"
          ? (result as { error: string }).error : stderr || `local ASR exited ${code ?? "unknown"}`;
        reject(new Error(detail));
      } catch {
        reject(new Error(stderr || `local ASR exited ${code ?? "unknown"}`));
      }
    });
    child.stdin.end(`${JSON.stringify(body)}\n`);
  });
}
