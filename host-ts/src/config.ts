export type JsonRecord = Record<string, unknown>;

export interface ToolConfig {
  id: string;
  name: string;
  adapter: "statusline" | "wrapper";
  bindings: Record<string, string>;
  deliveryHint?: string;
  process?: string;
  hidden?: boolean;
  discover?: boolean;
  command?: string;
  cwd?: string;
  delivery?: "auto" | "tmux" | "zellij" | "tty";
  aliases?: string[];
}

export interface Config {
  tools: ToolConfig[];
  asr: {
    engine: "faster-whisper" | "command" | "online";
    model: "tiny" | "base" | "small" | "medium";
    device: string;
    language: string | null;
    command: string;
    online: { api_base: string; api_key: string; model: string; language: string | null };
  };
  features: { process_watcher: boolean; voice_enabled: boolean };
  mic: { enabled: boolean; buttonA: FunctionKey; buttonB: FunctionKey };
  session_launcher: "auto" | "tmux" | "zellij";
}

const processes: Record<string, string> = {
  "claude-code": "claude", codex: "codex", opencode: "opencode", "kimi-cli": "kimi",
};
const isRecord = (value: unknown): value is JsonRecord => typeof value === "object" && value !== null && !Array.isArray(value);
const asString = (value: unknown, fallback = ""): string => typeof value === "string" ? value : fallback;
const language = (value: unknown): string | null => {
  const text = asString(value).trim();
  return !text || ["auto", "none", "null"].includes(text.toLowerCase()) ? null : text;
};
export type FunctionKey = "F13" | "F14" | "F15" | "F16" | "F17" | "F18" | "F19" | "F20" | "F21" | "F22" | "F23" | "F24";
const functionKeys: FunctionKey[] = ["F13", "F14", "F15", "F16", "F17", "F18", "F19", "F20", "F21", "F22", "F23", "F24"];
const functionKey = (value: unknown, fallback: FunctionKey): FunctionKey => functionKeys.includes(value as FunctionKey) ? value as FunctionKey : fallback;

export function normalizeConfig(value: unknown): Config {
  if (!isRecord(value)) throw new TypeError("config must be a JSON object");
  if (value.tools !== undefined && !Array.isArray(value.tools)) throw new TypeError("'tools' must be a list");
  const seen = new Set<string>();
  const tools: ToolConfig[] = [];
  for (const raw of value.tools ?? []) {
    if (!isRecord(raw)) continue;
    const id = asString(raw.id).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const rawBindings = isRecord(raw.bindings) ? raw.bindings : {};
    const bindings: Record<string, string> = {};
    for (const [key, binding] of Object.entries(rawBindings)) {
      if (key.trim() && typeof binding === "string") bindings[key.trim()] = binding;
    }
    const adapter = raw.adapter === "statusline" ? "statusline" : "wrapper";
    const delivery: "auto" | "tmux" | "zellij" | "tty" = ["auto", "tmux", "zellij", "tty"].includes(asString(raw.delivery))
      ? asString(raw.delivery) as "auto" | "tmux" | "zellij" | "tty" : "auto";
    const aliases = Array.isArray(raw.aliases)
      ? raw.aliases.map(String).filter((item) => item.trim()) : [];
    const tool: ToolConfig = { id, name: asString(raw.name, id) || id, adapter, bindings };
    const process = asString(raw.process).trim() || processes[id] || "";
    if (process) tool.process = process;
    if (asString(raw.delivery_hint)) tool.deliveryHint = asString(raw.delivery_hint);
    if (raw.hidden === true) tool.hidden = true;
    if (raw.discover === false) tool.discover = false;
    if (asString(raw.command).trim()) tool.command = asString(raw.command).trim();
    if (asString(raw.cwd).trim()) tool.cwd = asString(raw.cwd).trim();
    if (delivery !== "auto") tool.delivery = delivery;
    if (aliases.length) tool.aliases = aliases;
    tools.push(tool);
  }
  const rawAsr = isRecord(value.asr) ? value.asr : {};
  const engine = ["faster-whisper", "command", "online"].includes(asString(rawAsr.engine))
    ? asString(rawAsr.engine) as Config["asr"]["engine"] : "faster-whisper";
  const model = ["tiny", "base", "small", "medium"].includes(asString(rawAsr.model))
    ? asString(rawAsr.model) as Config["asr"]["model"] : "small";
  const rawOnline = isRecord(rawAsr.online) ? rawAsr.online : {};
  const rawFeatures = isRecord(value.features) ? value.features : {};
  const rawMic = isRecord(value.mic) ? value.mic : {};
  const launcher = ["auto", "tmux", "zellij"].includes(asString(value.session_launcher))
    ? asString(value.session_launcher) as Config["session_launcher"] : "auto";
  return {
    tools,
    asr: { engine, model, device: asString(rawAsr.device, "cpu") || "cpu", language: language(rawAsr.language), command: asString(rawAsr.command), online: {
      api_base: asString(rawOnline.api_base, "https://api.groq.com/openai/v1") || "https://api.groq.com/openai/v1",
      api_key: asString(rawOnline.api_key), model: asString(rawOnline.model, "whisper-large-v3-turbo") || "whisper-large-v3-turbo", language: language(rawOnline.language),
    }},
    features: { process_watcher: rawFeatures.process_watcher !== false, voice_enabled: rawFeatures.voice_enabled !== false },
    mic: { enabled: rawMic.enabled !== false, buttonA: functionKey(rawMic.button_a, "F14"), buttonB: functionKey(rawMic.button_b, "F15") },
    session_launcher: launcher,
  };
}

/** Convert the internal camelCase model to the stable Python/BLE JSON schema. */
export function configToWire(config: Config): JsonRecord {
  return {
    tools: config.tools.map((tool) => {
      const wire: JsonRecord = { id: tool.id, name: tool.name, adapter: tool.adapter, bindings: tool.bindings };
      if (tool.deliveryHint) wire.delivery_hint = tool.deliveryHint;
      if (tool.process) wire.process = tool.process;
      if (tool.hidden) wire.hidden = true;
      if (tool.discover === false) wire.discover = false;
      if (tool.command) wire.command = tool.command;
      if (tool.cwd) wire.cwd = tool.cwd;
      if (tool.delivery && tool.delivery !== "auto") wire.delivery = tool.delivery;
      if (tool.aliases?.length) wire.aliases = tool.aliases;
      return wire;
    }),
    asr: config.asr,
    features: config.features,
    mic: {
      enabled: config.mic.enabled,
      ...(config.mic.buttonA !== "F14" ? { button_a: config.mic.buttonA } : {}),
      ...(config.mic.buttonB !== "F15" ? { button_b: config.mic.buttonB } : {}),
    },
    session_launcher: config.session_launcher,
  };
}
