import type { Config } from "./config.js";

export interface OnlineAsrInput { api_base?: unknown; model?: unknown; api_key?: unknown; }
export interface PublicAsrSettings { engine: string; api_base: string; model: string; configured: boolean; }

/** Validate only the editable online-ASR fields; secrets are never returned. */
export function updateOnlineAsr(config: Config, input: OnlineAsrInput | unknown): Config {
  const values: OnlineAsrInput = typeof input === "object" && input !== null && !Array.isArray(input) ? input as OnlineAsrInput : {};
  const apiBase = string(values.api_base, config.asr.online.api_base).trim();
  const model = string(values.model, config.asr.online.model).trim();
  if (!apiBase || !/^https?:\/\//.test(apiBase)) throw new TypeError("ASR API base must be an http(s) URL");
  if (!model || model.length > 160) throw new TypeError("ASR model is required");
  const key = typeof values.api_key === "string" && values.api_key.trim() ? values.api_key.trim() : config.asr.online.api_key;
  return { ...config, asr: { ...config.asr, engine: "online", online: { ...config.asr.online, api_base: apiBase, model, api_key: key } } };
}

export function publicAsrSettings(config: Config): PublicAsrSettings {
  return { engine: config.asr.engine, api_base: config.asr.online.api_base, model: config.asr.online.model, configured: config.asr.engine === "online" && Boolean(config.asr.online.api_key) };
}

export function updateSessionLauncher(config: Config, input: unknown): Config {
  const launcher = typeof input === "object" && input !== null && "session_launcher" in input ? (input as { session_launcher?: unknown }).session_launcher : undefined;
  if (launcher !== "auto" && launcher !== "tmux" && launcher !== "zellij") throw new TypeError("Session launcher must be auto, tmux, or zellij");
  return { ...config, session_launcher: launcher };
}

export function updateToolCwd(config: Config, input: unknown): Config {
  const values = typeof input === "object" && input !== null && !Array.isArray(input) ? input as { id?: unknown; cwd?: unknown } : {};
  const id = typeof values.id === "string" ? values.id : "";
  const cwd = typeof values.cwd === "string" ? values.cwd.trim() : "";
  if (!id || !config.tools.some((tool) => tool.id === id)) throw new TypeError("Unknown Agent CLI tool");
  return {
    ...config,
    tools: config.tools.map((tool) => {
      if (tool.id !== id) return tool;
      const { cwd: _previousCwd, ...withoutCwd } = tool;
      return cwd ? { ...withoutCwd, cwd } : withoutCwd;
    }),
  };
}

const string = (value: unknown, fallback: string): string => typeof value === "string" ? value : fallback;
