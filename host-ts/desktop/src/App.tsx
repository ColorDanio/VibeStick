import {
  createContext,
  useEffect,
  useContext,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import stickCPlusImage from "./assets/m5stickc-plus-product-v2.png";
import stickS3Image from "./assets/m5sticks3-concept.png";

type Page = "overview" | "sessions" | "voice" | "settings";
type ThemePreference = "system" | "light" | "dark";
type LanguagePreference = "system" | "en" | "zh";
type Locale = "en" | "zh";
type Translate = (english: string, chinese: string) => string;
const LocaleContext = createContext<Locale>("en");
function useT(): Translate {
  const locale = useContext(LocaleContext);
  return (english, chinese) => locale === "zh" ? chinese : english;
}
type LocalModelStatus = { model: string; state: "idle" | "downloading" | "ready" | "applying" | "applied" | "error"; progress: number; detail?: string };
type MicBindingFeedback = { state: "idle" | "saving" | "synced" | "saved" | "error"; text: string };
type Capability = { available: boolean; reason?: string; testable?: boolean };
type Session = {
  id: string;
  state: "idle" | "running" | "waiting";
  name?: string;
  session?: string;
  model?: string;
  last?: string;
  tool: string;
};
type Agent = { id: string; name: string; state: string };
type Snapshot = {
  selected_tool: string | null;
  active_session: string | null;
  audio_route: "asr" | "mic";
  device_mode: "home" | "agent" | "mic" | "yolo";
  device: { name?: string; model: string; firmware: string };
  foreground_target?: { app: string };
  voice: { state: "idle" | "recording" | "transcribing" | "ready" | "error"; mode: "agent" | "mic" | "yolo"; recorded_ms: number; level: number; text: string };
  transcriptions: { at: number; source: "agent" | "yolo"; text: string }[];
  transfers: { at: number; kind: "recording" | "transcript" | "delivery" | "audio" | "error"; text: string }[];
  queued: number;
  status: { state: string; session: string; tool: string; model: string };
  sessions: { list: Session[] };
  tools: { list: Agent[] };
  environment: {
    owner: "active" | "inactive";
    runtime: string;
    capabilities: {
      ble: Capability;
      keyboard: Capability;
      mic: Capability;
      asr: Capability;
      yolo?: Capability;
    };
    traditional_owner: { state: "running" | "unavailable"; detail?: string };
    config: {
      path: string;
      asr_engine: string;
      asr_api_base: string;
      asr_model: string;
      asr_online_model?: string;
      online_asr_configured: boolean;
      mic_button_a?: string;
      mic_button_b?: string;
      session_launcher: "auto" | "tmux" | "zellij";
      tools: { id: string; name: string; cwd: string }[];
    };
    error?: string;
  };
};
const api = async (path: string, init?: RequestInit): Promise<Snapshot> => {
  const response = await fetch(`http://127.0.0.1:7861${path}`, init);
  if (!response.ok) throw new Error(`Host 2.0 API returned ${response.status}`);
  return response.json() as Promise<Snapshot>;
};
const demo: Snapshot = {
  selected_tool: "opencode",
  active_session: "design",
  audio_route: "asr",
  device_mode: "home",
  device: { name: "", model: "", firmware: "" },
  voice: { state: "idle", mode: "agent", recorded_ms: 0, level: 0, text: "" },
  transcriptions: [],
  transfers: [],
  queued: 0,
  status: {
    state: "idle",
    session: "Design system",
    tool: "opencode",
    model: "",
  },
  sessions: {
    list: [
      {
        id: "design",
        tool: "opencode",
        state: "idle",
        session: "Design system",
        model: "",
        last: "Ready for your next prompt",
      },
      {
        id: "release",
        tool: "codex",
        state: "running",
        session: "Release notes",
        model: "",
        last: "Writing the changelog…",
      },
    ],
  },
  tools: {
    list: [
      { id: "opencode", name: "OpenCode", state: "ready" },
      { id: "codex", name: "Codex", state: "running" },
    ],
  },
  environment: {
    owner: "inactive",
    runtime: "stopped",
    capabilities: {
      ble: { available: false, reason: "Start Vibe Stick" },
      keyboard: { available: false, reason: "Waiting for handoff" },
      mic: { available: false, reason: "Waiting for handoff" },
      asr: { available: false, reason: "Configure ASR" },
      yolo: { available: false, reason: "Waiting for handoff" },
    },
    traditional_owner: { state: "unavailable" },
    config: {
      path: "~/.vibestick/config.json",
      asr_engine: "faster-whisper",
      asr_api_base: "",
      asr_model: "small",
      asr_online_model: "whisper-large-v3-turbo",
      online_asr_configured: false,
      mic_button_a: "F14",
      mic_button_b: "F15",
      session_launcher: "auto",
      tools: [{ id: "opencode", name: "OpenCode", cwd: "" }],
    },
  },
};

export function App(): ReactElement {
  const [data, setData] = useState<Snapshot>(demo);
  const [page, setPage] = useState<Page>("overview");
  const [connected, setConnected] = useState(false);
  const [notice, setNotice] = useState("");
  const [theme, setTheme] = useState<ThemePreference>(() => {
    const saved = window.localStorage.getItem("vibeconn-theme");
    return saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
  });
  const [language, setLanguage] = useState<LanguagePreference>(() => {
    const saved = window.localStorage.getItem("vibestick-language");
    return saved === "en" || saved === "zh" || saved === "system" ? saved : "system";
  });
  const [systemLocale, setSystemLocale] = useState<Locale>(() => navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en");
  const locale: Locale = language === "system" ? systemLocale : language;
  const t: Translate = (english, chinese) => locale === "zh" ? chinese : english;
  const [apiBase, setApiBase] = useState(demo.environment.config.asr_api_base);
  const [onlineModel, setOnlineModel] = useState(
    demo.environment.config.asr_online_model ?? "",
  );
  const [localModel, setLocalModel] = useState(
    demo.environment.config.asr_model,
  );
  const [asrMode, setAsrMode] = useState<"local" | "online">("local");
  const [asrDirty, setAsrDirty] = useState(false);
  const [localModelStatus, setLocalModelStatus] = useState<LocalModelStatus>({ model: "", state: "idle", progress: 0 });
  const [apiKey, setApiKey] = useState("");
  const [micButtonA, setMicButtonA] = useState("F14");
  const [micButtonB, setMicButtonB] = useState("F15");
  const [micBindingsDirty, setMicBindingsDirty] = useState(false);
  const [micBindingFeedback, setMicBindingFeedback] = useState<MicBindingFeedback>({ state: "idle", text: "" });
  const [saving, setSaving] = useState(false);
  const [launcher, setLauncher] = useState<"auto" | "tmux" | "zellij">("auto");
  const [cwdTool, setCwdTool] = useState("");
  const [cwd, setCwd] = useState("");
  const [loginEnabled, setLoginEnabled] = useState<boolean>();
  const [busy, setBusy] = useState<string>();
  const [testing, setTesting] = useState<"asr" | "yolo">();
  const initialized = useRef(false);
  const previousDeviceMode = useRef<Snapshot["device_mode"]>(demo.device_mode);
  useEffect(() => {
    document.title = "Vibe Stick";
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
    if (isTauri()) void getCurrentWindow().setTitle("Vibe Stick");
  }, [locale]);
  useEffect(() => {
    const update = (): void => setSystemLocale(navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en");
    window.addEventListener("languagechange", update);
    window.localStorage.setItem("vibestick-language", language);
    return () => window.removeEventListener("languagechange", update);
  }, [language]);
  useEffect(() => {
    if (page !== "settings" || asrMode !== "local") return;
    let alive = true;
    const refresh = async (): Promise<void> => {
      try {
        const response = await fetch("http://127.0.0.1:7861/api/settings/asr/local/download");
        if (response.ok && alive) setLocalModelStatus(await response.json() as LocalModelStatus);
      } catch { /* host availability is shown elsewhere */ }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), localModelStatus.state === "downloading" || localModelStatus.state === "applying" ? 500 : 1600);
    return () => { alive = false; window.clearInterval(timer); };
  }, [page, asrMode, localModelStatus.state]);
  useEffect(() => {
    if (data.device_mode === "agent" && previousDeviceMode.current !== "agent") {
      setPage("sessions");
    }
    previousDeviceMode.current = data.device_mode;
  }, [data.device_mode]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (): void => {
      document.documentElement.dataset.theme = theme === "system" ? (media.matches ? "dark" : "light") : theme;
    };
    apply();
    media.addEventListener("change", apply);
    window.localStorage.setItem("vibeconn-theme", theme);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  useEffect(() => {
    let alive = true;
    const refresh = async (): Promise<void> => {
      try {
        const next = await api("/api/desktop");
        if (alive) {
          setData(next);
          setConnected(true);
          if (!next.environment.error && next.environment.owner === "active")
            setNotice("");
        }
      } catch {
        if (alive) setConnected(false);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1200);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!asrDirty) {
      setApiBase(data.environment.config.asr_api_base);
      setOnlineModel(
        data.environment.config.asr_online_model ??
          data.environment.config.asr_model,
      );
      if (data.environment.config.asr_engine !== "online")
        setLocalModel(data.environment.config.asr_model);
      setAsrMode(
        data.environment.config.asr_engine === "online" ? "online" : "local",
      );
    }
    setLauncher(data.environment.config.session_launcher);
    // Settings polling must not overwrite a shortcut while its modifier
    // checkbox is being edited. The Host snapshot only becomes authoritative
    // again after a successful save.
    if (!micBindingsDirty) {
      setMicButtonA(data.environment.config.mic_button_a ?? "F14");
      setMicButtonB(data.environment.config.mic_button_b ?? "F15");
    }
    if (!initialized.current && data.environment.config.tools.length) {
      const tool = data.environment.config.tools[0]!;
      setCwdTool(tool.id);
      setCwd(tool.cwd);
      initialized.current = true;
    }
  }, [data.environment.config, asrDirty, micBindingsDirty]);
  useEffect(() => {
    if (!isTauri()) return;
    void invoke<{ enabled: boolean }>("login_startup", { action: "status" })
      .then((result) => setLoginEnabled(result.enabled))
      .catch(() => setLoginEnabled(undefined));
  }, []);
  const send = async (cmd: string, id?: string): Promise<void> => {
    try {
      setData(
        await api("/api/command", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cmd, ...(id ? { id } : {}) }),
        }),
      );
    } catch {
      setNotice(t("This action needs a running Vibe Stick host.", "此操作需要正在运行的 Vibe Stick 主机。"));
    }
  };
  const release = async (): Promise<void> => {
    setBusy("release");
    try {
      if (isTauri()) {
        const result = await invoke<{ ok: boolean; detail: string }>(
          "release_python_owner",
        );
        setNotice(result.detail);
        return;
      }
      const response = await fetch("http://127.0.0.1:7860/api/command", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cmd: "owner.release" }),
      });
      if (!response.ok)
        throw new Error(
          `Python 1.x refused owner release (${response.status}).`,
        );
      setNotice(
        t("Python 1.x released BLE. Vibe Stick will retry the connection shortly.", "Python 1.x 已释放 BLE，Vibe Stick 将很快重试连接。"),
      );
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : t("Could not release the Python 1.x owner.", "无法释放 Python 1.x 的连接。"),
      );
    } finally {
      setBusy(undefined);
    }
  };
  const saveAsr = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSaving(true);
    try {
      const response = await fetch(asrMode === "local" ? "http://127.0.0.1:7861/api/settings/asr/local/apply" : "http://127.0.0.1:7861/api/settings/asr", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          asrMode === "local"
            ? { mode: "local", local_model: localModel }
            : {
                mode: "online",
                api_base: apiBase,
                model: onlineModel,
                ...(apiKey ? { api_key: apiKey } : {}),
              },
        ),
      });
      const result: unknown = await response.json().catch(() => undefined);
      if (!response.ok) {
        const detail = typeof result === "object" && result !== null && typeof (result as { error?: unknown }).error === "string"
          ? (result as { error: string }).error : t("Could not prepare and save ASR settings.", "无法准备并保存 ASR 设置。");
        throw new Error(detail);
      }
      setApiKey("");
      // Keep the chosen values stable until the restarted Host reports its
      // new configuration; an older polling snapshot must not reset the menu.
      setAsrDirty(true);
      setNotice(asrMode === "local" ? t("Local model applied. Restart Vibe Stick to activate it.", "本地模型已应用。请重启 Vibe Stick 使其生效。") : t("Online ASR saved. Restart Vibe Stick to activate it.", "在线 ASR 已保存。请重启 Vibe Stick 使其生效。"));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t("Could not prepare and save ASR settings.", "无法准备并保存 ASR 设置。"));
    } finally {
      setSaving(false);
    }
  };
  const downloadLocalModel = async (): Promise<void> => {
    setLocalModelStatus({ model: localModel, state: "downloading", progress: 0, detail: "Starting download…" });
    try {
      const response = await fetch("http://127.0.0.1:7861/api/settings/asr/local/download", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "local", local_model: localModel }),
      });
      const result: unknown = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(typeof result === "object" && result !== null && typeof (result as { error?: unknown }).error === "string" ? (result as { error: string }).error : "Could not start model download");
      setLocalModelStatus(result as LocalModelStatus);
    } catch (error) {
      setLocalModelStatus({ model: localModel, state: "error", progress: 0, detail: error instanceof Error ? error.message : String(error) });
    }
  };
  const saveLauncher = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy("launcher");
    try {
      const response = await fetch(
        "http://127.0.0.1:7861/api/settings/session-launcher",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session_launcher: launcher }),
        },
      );
      if (!response.ok) throw new Error();
      setNotice(t("New-session launcher saved.", "新会话启动方式已保存。"));
    } catch {
      setNotice(t("Could not save launcher.", "无法保存启动方式。"));
    } finally {
      setBusy(undefined);
    }
  };
  const saveCwd = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy("cwd");
    try {
      const response = await fetch(
        "http://127.0.0.1:7861/api/settings/tool-cwd",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: cwdTool, cwd }),
        },
      );
      if (!response.ok) throw new Error();
      setNotice(t("Working directory saved.", "工作目录已保存。"));
    } catch {
      setNotice(t("Could not save directory.", "无法保存工作目录。"));
    } finally {
      setBusy(undefined);
    }
  };
  const saveMicBindings = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy("mic-bindings");
    setMicBindingFeedback({ state: "saving", text: t("Saving shortcut…", "正在保存快捷键…") });
    try {
      const response = await fetch("http://127.0.0.1:7861/api/settings/mic-bindings", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ button_a: micButtonA, button_b: micButtonB }),
      });
      const result = await response.json().catch(() => ({})) as { device_synced?: boolean; error?: string };
      if (!response.ok) throw new Error(result.error ?? t("Could not save Vibe Mic button bindings.", "无法保存 Vibe Mic 按键映射。"));
      setMicBindingsDirty(false);
      const feedback = result.device_synced
        ? { state: "synced" as const, text: t("Saved • sent to connected Stick", "已保存 • 已发送到当前连接的 Stick") }
        : { state: "saved" as const, text: t("Saved • will send when Stick reconnects", "已保存 • Stick 重连后将自动发送") };
      setMicBindingFeedback(feedback); setNotice(feedback.text);
    } catch (error) {
      const text = error instanceof Error ? error.message : t("Could not save Vibe Mic button bindings.", "无法保存 Vibe Mic 按键映射。");
      setMicBindingFeedback({ state: "error", text }); setNotice(text);
    }
    finally { setBusy(undefined); }
  };
  const login = async (action: "install" | "uninstall"): Promise<void> => {
    if (!isTauri()) return;
    setBusy(action);
    try {
      const result = await invoke<{ enabled: boolean; detail: string }>(
        "login_startup",
        { action },
      );
      setLoginEnabled(result.enabled);
      setNotice(result.detail);
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : t("Could not update startup registration.", "无法更新开机启动设置。"),
      );
    } finally {
      setBusy(undefined);
    }
  };
  const restart = async (): Promise<void> => {
    setBusy("restart");
    try {
      if (!isTauri())
        throw new Error(t("Restart is available from the Vibe Stick desktop app.", "只能从 Vibe Stick 桌面应用重启。"));
      setNotice((await invoke<{ detail: string }>("restart_host")).detail);
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : t("Could not restart Vibe Stick.", "无法重启 Vibe Stick。"),
      );
    } finally {
      setBusy(undefined);
    }
  };
  const testProvider = async (kind: "asr" | "yolo"): Promise<void> => {
    setTesting(kind);
    try {
      const response = await fetch(
        `http://127.0.0.1:7861/api/settings/${kind}/test`,
        { method: "POST" },
      );
      const body = (await response.json()) as { detail?: string };
      setNotice(
        body.detail ??
          (response.ok
            ? `${kind.toUpperCase()} is reachable.`
            : `${kind.toUpperCase()} test failed.`),
      );
    } catch {
      setNotice(`Could not test ${kind.toUpperCase()}.`);
    } finally {
      setTesting(undefined);
    }
  };
  const yolo = data.environment.capabilities.yolo;
  const selected =
    data.sessions.list.find((session) => session.id === data.active_session) ??
    data.sessions.list.find((session) => session.tool === data.selected_tool);
  const ownerBlocked =
    data.environment.traditional_owner.state === "running" &&
    data.environment.owner === "inactive";
  const title: Record<Page, string> = {
    overview: t("Overview", "概览"),
    sessions: t("Sessions", "会话"),
    voice: t("Voice", "语音"),
    settings: t("Settings", "设置"),
  };
  return (
    <LocaleContext.Provider value={locale}>
    <main className="vibe-app">
      <aside className="rail">
        <button className="wordmark" onClick={() => setPage("overview")}>
          <span>V</span>
          <b>Vibe Stick</b>
          <small>0.2</small>
        </button>
        <nav aria-label={t("Primary navigation", "主导航")}>
          <Nav
            page={page}
            target="overview"
            label={t("Overview", "概览")}
            icon="⌂"
            onClick={setPage}
          />
          <Nav
            page={page}
            target="sessions"
            label={t("Sessions", "会话")}
            icon="▤"
            onClick={setPage}
          />
          <Nav
            page={page}
            target="voice"
            label={t("Voice", "语音")}
            icon="◌"
            onClick={setPage}
          />
          <Nav
            page={page}
            target="settings"
            label={t("Settings", "设置")}
            icon="⚙"
            onClick={setPage}
          />
        </nav>
        <div className="rail-status">
          {connected ? t("Vibe Stick desktop", "Vibe Stick 桌面端") : t("Connecting to host…", "正在连接主机…")}
        </div>
      </aside>
      <section className="canvas">
        <header className="app-header">
          <h1>{title[page]}</h1>
          <div className="connection">
            <i
              className={
                data.environment.owner === "active" ? "online" : "warn"
              }
            />
            <span>
              {data.environment.owner === "active"
                ? t("VibeStick connected", "VibeStick 已连接")
                : ownerBlocked
                  ? t("Handoff required", "需要移交连接")
                  : t("Standby", "待机")}
            </span>
          </div>
        </header>
        {notice && (
          <div className="notice">
            <span>{notice}</span>
            <button onClick={() => setNotice("")} aria-label={t("Dismiss", "关闭")}>
              ×
            </button>
          </div>
        )}
        {page === "overview" && (
          <Overview
            data={data}
            selected={selected}
            ownerBlocked={ownerBlocked}
            busy={busy}
            onRelease={() => void release()}
            onReconnect={() => void restart()}
          />
        )}
        {page === "sessions" && (
          <Sessions
            data={data}
            onSelect={(id) => void send("session.select", id)}
            onTool={(id) => void send("tool.select", id)}
            onNew={() => void send("session.new")}
            launcher={launcher}
            cwdTool={cwdTool}
            cwd={cwd}
            busy={busy}
            onLauncher={setLauncher}
            onSaveLauncher={saveLauncher}
            onCwdTool={(id) => {
              setCwdTool(id);
              setCwd(data.environment.config.tools.find((tool) => tool.id === id)?.cwd ?? "");
            }}
            onCwd={setCwd}
            onSaveCwd={saveCwd}
          />
        )}
        {page === "voice" && <Voice transcriptions={data.transcriptions} />}
        {page === "settings" && (
          <Settings
            data={data}
            apiBase={apiBase}
            onlineModel={onlineModel}
            localModel={localModel}
            localModelStatus={localModelStatus}
            asrMode={asrMode}
            apiKey={apiKey}
            micButtonA={micButtonA}
            micButtonB={micButtonB}
            micBindingFeedback={micBindingFeedback}
            saving={saving}
            busy={busy}
            testing={testing}
            theme={theme}
            language={language}
            desktopShell={isTauri()}
            loginEnabled={loginEnabled}
            onApiBase={(value) => { setApiBase(value); setAsrDirty(true); }}
            onTheme={setTheme}
            onLanguage={setLanguage}
            onOnlineModel={(value) => { setOnlineModel(value); setAsrDirty(true); }}
            onLocalModel={(model) => {
              setLocalModel(model);
              setAsrDirty(true);
              if (model !== localModelStatus.model) setLocalModelStatus({ model, state: "idle", progress: 0 });
            }}
            onDownloadLocalModel={() => void downloadLocalModel()}
            onAsrMode={(mode) => {
              setAsrMode(mode);
              setAsrDirty(true);
            }}
            onApiKey={(value) => { setApiKey(value); setAsrDirty(true); }}
            onMicButtonA={(value) => { setMicButtonA(value); setMicBindingsDirty(true); setMicBindingFeedback({ state: "idle", text: "" }); }}
            onMicButtonB={(value) => { setMicButtonB(value); setMicBindingsDirty(true); setMicBindingFeedback({ state: "idle", text: "" }); }}
            onSaveMicBindings={saveMicBindings}
            onSaveAsr={saveAsr}
            onTestAsr={() => void testProvider("asr")}
            onTestYolo={() => void testProvider("yolo")}
            onRestart={() => void restart()}
            onLogin={login}
          />
        )}
      </section>
    </main>
    </LocaleContext.Provider>
  );
}
function Nav({
  page,
  target,
  label,
  icon,
  onClick,
}: {
  page: Page;
  target: Page;
  label: string;
  icon: string;
  onClick: (page: Page) => void;
}): ReactElement {
  return (
    <button
      className={page === target ? "nav-item active" : "nav-item"}
      onClick={() => onClick(target)}
    >
      <span>{icon}</span>
      {label}
    </button>
  );
}
function Overview({
  data,
  selected,
  ownerBlocked,
  busy,
  onRelease,
  onReconnect,
}: {
  data: Snapshot;
  selected?: Session;
  ownerBlocked: boolean;
  busy?: string;
  onRelease(): void;
  onReconnect(): void;
}): ReactElement {
  const t = useT();
  const caps = data.environment.capabilities;
  const agents = data.tools.list;
  const hasActiveStick = data.environment.owner === "active" && Boolean(data.device.name || data.device.model);
  return (
    <div className="overview-dashboard">
      {hasActiveStick ? <section className="device-card dashboard-hero">
        <DeviceImage model={data.device.model} />
        <div className="device-copy">
          <span className="section-label">{t("STICK STATUS", "设备状态")}</span>
          <h2>{data.device.name || deviceName(data.device.model)}</h2>
          <p>
            {data.environment.owner === "active"
              ? t("Connected, synchronized, and ready for voice input.", "已连接并同步，可以开始语音输入。")
              : t("Waiting to become the active Vibe Stick device.", "正在等待成为当前活动设备。")}
          </p>
          <div className="device-facts">
            <StatusFact label="BLE" value={caps.ble.available ? t("Ready", "就绪") : t("Unavailable", "不可用")} />
            <StatusFact label="ASR" value={caps.asr.available ? t("Ready", "就绪") : t("Setup needed", "需要设置")} />
            <StatusFact label={t("Mode", "模式")} value={modeName(data.device_mode, t)} />
            {data.device.firmware && <StatusFact label={t("Firmware", "固件")} value={data.device.firmware} />}
          </div>
        </div>
        {ownerBlocked ? (
          <div className="handoff-panel">
            <span>{t("Python 1.x owns the Stick", "Python 1.x 正在占用设备")}</span>
            <p>{t("Release it once; Vibe Stick will reconnect automatically.", "释放后，Vibe Stick 会自动重新连接。")}</p>
            <button
              className="primary"
              onClick={onRelease}
              disabled={busy === "release"}
            >
              {busy === "release" ? t("Releasing…", "正在释放…") : t("Release to Vibe Stick", "释放给 Vibe Stick")}
            </button>
          </div>
        ) : (
          <div className="device-state device-actions">
            <b>{data.environment.owner === "active" ? t("Connected", "已连接") : t("Waiting", "等待中")}</b>
            <span>{data.environment.runtime}</span>
            <button className="secondary" onClick={onReconnect} disabled={busy === "restart"}>
              {busy === "restart" ? t("Reconnecting…", "正在重连…") : t("Reconnect", "重新连接")}
            </button>
          </div>
        )}
      </section> : <section className="panel empty-state">
        <span className="section-label">{t("DEVICE SETUP", "设备设置")}</span>
        <h2>{t("No VibeStick connected", "尚未连接 VibeStick")}</h2>
        <p>{t("Scan and select a Stick in Settings to make it this host's active device.", "请在设置中扫描并选择一个设备，将它设为此主机的活动设备。")}</p>
      </section>}
      <section className="dashboard-grid">
        <LiveActivity data={data} selected={selected} />
        <CurrentTarget data={data} selected={selected} agents={agents} />
      </section>
    </div>
  );
}
function StatusFact({ label, value }: { label: string; value: string }): ReactElement {
  return <span className="status-fact"><small>{label}</small><b>{value}</b></span>;
}
function LiveActivity({ data, selected }: { data: Snapshot; selected?: Session }): ReactElement {
  const t = useT();
  const rows = data.transcriptions.slice(0, 6).map((item) => ({ at: item.at, mode: item.source === "yolo" ? "YOLO" : t("Agent", "智能体"), text: item.text }));
  if (!rows.length && selected) rows.push({ at: 0, mode: modeName(data.device_mode, t), text: selected.last || t("Ready for your next prompt", "可以开始下一次输入") });
  return <section className="panel live-activity"><div className="panel-head"><div><span className="section-label">{t("LIVE ACTIVITY", "实时活动")}</span><h2>{t("Latest", "最近")}</h2></div></div>{rows.length ? <div className="latest-list">{rows.map((row, index) => <article className="latest-row" key={`${row.at}-${index}`}><time>{row.at ? formatTime(row.at) : t("Now", "现在")}</time><span>{t("Latest ·", "最近 ·")}</span><b className={`mode-chip ${row.mode.toLowerCase().replaceAll(" ", "-")}`}>{row.mode}</b><p>{row.text}</p></article>)}</div> : <Empty text={t("Activity from the Stick will appear here.", "设备活动会显示在这里。")} />}</section>;
}
function CurrentTarget({ data, selected, agents }: { data: Snapshot; selected?: Session; agents: Agent[] }): ReactElement {
  const t = useT();
  return <section className="panel current-target"><span className="section-label">{t("CURRENT TARGET", "当前目标")}</span><div className="target-mark">›_</div><h2>{currentTarget(data, selected, t)}</h2><p className="lede">{targetDetail(data, selected, agents, t)}</p><div className="target-mode"><i className={data.environment.owner === "active" ? "online" : "warn"} />{modeName(data.device_mode, t)}</div></section>;
}
function deviceName(model: string): string {
  const kind = stickKind(model);
  if (kind === "s3") return "M5StickS3";
  if (kind === "cplus") return "M5StickC Plus";
  return model || "VibeStick";
}
function DeviceImage({ model }: { model: string }): ReactElement {
  const kind = stickKind(model);
  if (kind === "s3") return <div className="stick stick-s3" aria-label="M5StickS3 product image"><img src={stickS3Image} alt="M5StickS3" /></div>;
  if (kind === "cplus") return <div className="stick stick-cplus" aria-label="M5StickC Plus product image"><img src={stickCPlusImage} alt="M5StickC Plus" /></div>;
  // Do not make up a C Plus image while the firmware model notification is
  // still in flight. The neutral marker prevents incorrect hardware art.
  return <div className="stick stick-unknown" aria-label="VibeStick model pending identification">VS</div>;
}
function stickKind(model: string): "s3" | "cplus" | undefined {
  const normalized = model.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
  if (normalized.includes("sticks3")) return "s3";
  if (normalized.includes("stickcplus")) return "cplus";
  return undefined;
}
function modeName(mode: Snapshot["device_mode"], t: Translate = (english) => english): string {
  return mode === "agent" ? "Agent CLI" : mode === "mic" ? "Vibe Mic" : mode === "yolo" ? "YOLO" : t("Main menu", "主菜单");
}
function currentTarget(data: Snapshot, selected: Session | undefined, t: Translate): string {
  if (data.device_mode === "mic" || data.device_mode === "yolo")
    return data.foreground_target?.app ?? t("Detecting focused application…", "正在检测当前应用…");
  return selected ? sessionTitle(selected, t) : t("No session selected", "未选择会话");
}
function targetDetail(data: Snapshot, selected: Session | undefined, agents: Agent[], t: Translate): string {
  if (data.device_mode === "mic")
    return data.foreground_target
      ? t("Foreground application only — its window content is not read or shown.", "仅识别前台应用，不读取或显示窗口内容。")
      : t("Move the cursor to an application window to identify it. Window content is never read.", "将焦点移到目标应用窗口；Vibe Stick 不会读取窗口内容。")
  if (data.device_mode === "yolo")
    return data.foreground_target
      ? t("YOLO sends text to this focused application. Window content is not read or shown.", "YOLO 会向当前应用输入文字，不读取或显示窗口内容。")
      : t("Move the cursor to the intended application window before using YOLO.", "使用 YOLO 前，请先切换到目标应用窗口。")
  return selected
    ? `${agentName(agents, selected.tool)} · ${selected.last || t("Ready for your next prompt", "可以开始下一次输入")}`
    : t("Select an Agent CLI session in Sessions before sending a transcript.", "发送转写前，请先在“会话”中选择 Agent CLI 会话。");
}
function Sessions({
  data,
  onSelect,
  onTool,
  onNew,
  launcher,
  cwdTool,
  cwd,
  busy,
  onLauncher,
  onSaveLauncher,
  onCwdTool,
  onCwd,
  onSaveCwd,
}: {
  data: Snapshot;
  onSelect(id: string): void;
  onTool(id: string): void;
  onNew(): void;
  launcher: "auto" | "tmux" | "zellij";
  cwdTool: string;
  cwd: string;
  busy?: string;
  onLauncher(value: "auto" | "tmux" | "zellij"): void;
  onSaveLauncher(event: FormEvent): void;
  onCwdTool(value: string): void;
  onCwd(value: string): void;
  onSaveCwd(event: FormEvent): void;
}): ReactElement {
  const t = useT();
  const sessions = data.sessions.list.filter(
    (session) => session.tool === data.selected_tool,
  );
  return (
    <section className="wide-panel">
      <div className="panel-head">
        <div>
          <span className="section-label">AGENT CLI</span>
          <h2>{t("Sessions", "会话")}</h2>
          <p>
            {t("Choose an agent first, then select where its transcripts are delivered.", "先选择智能体，再选择转写内容要发送到的会话。")}
          </p>
        </div>
        <button className="primary" onClick={onNew}>
          ＋ {t("New session", "新建会话")}
        </button>
      </div>
      <AgentBar
        agents={data.tools.list}
        selected={data.selected_tool}
        onSelect={onTool}
      />
      <div className="session-table">
        {sessions.length ? (
          sessions.map((session) => (
            <button
              className={
                session.id === data.active_session
                  ? "session-row selected"
                  : "session-row"
              }
              key={session.id}
              onClick={() => onSelect(session.id)}
            >
              <Status state={session.state} />
              <div>
                <b>{sessionTitle(session, t)}</b>
                <span>
                  {agentName(data.tools.list, session.tool)}
                  {session.last ? ` · ${session.last}` : ""}
                </span>
              </div>
              <em>
                {session.id === data.active_session
                  ? t("Selected", "已选择")
                  : session.state === "idle"
                    ? t("Ready", "就绪")
                    : session.state}
              </em>
            </button>
          ))
        ) : (
          <Empty
            text={t(`No ${agentName(data.tools.list, data.selected_tool)} session is available yet.`, `暂时没有可用的 ${agentName(data.tools.list, data.selected_tool)} 会话。`)}
          />
        )}
      </div>
      <div className="session-preferences">
        <div>
          <span className="section-label">{t("SESSION PREFERENCES", "会话偏好")}</span>
          <h3>{t("New sessions", "新建会话")}</h3>
          <p className="lede">{t("Controls where Stick-created Agent CLI sessions open.", "控制设备创建的 Agent CLI 会话在哪里打开。")}</p>
        </div>
        <form className="form-block inline" onSubmit={onSaveLauncher}>
          <div><h3>{t("Launcher", "启动方式")}</h3><p>{t("Terminal multiplexer for new sessions.", "新会话使用的终端复用器。")}</p></div>
          <select value={launcher} onChange={(event) => onLauncher(event.target.value as "auto" | "tmux" | "zellij")}>
            <option value="auto">{t("Auto", "自动")}</option><option value="tmux">tmux</option><option value="zellij">zellij</option>
          </select>
          <button className="secondary" disabled={busy === "launcher"}>{t("Save", "保存")}</button>
        </form>
        <form className="form-block inline" onSubmit={onSaveCwd}>
          <div><h3>{t("Working directory", "工作目录")}</h3><p>{t("Used when a new session is created for this Agent CLI.", "为此 Agent CLI 创建新会话时使用。")}</p></div>
          <select value={cwdTool} onChange={(event) => onCwdTool(event.target.value)}>
            {data.environment.config.tools.map((tool) => <option key={tool.id} value={tool.id}>{tool.name}</option>)}
          </select>
          <input value={cwd} placeholder={t("Empty: inherit pane / home", "留空：继承窗格或主目录")} onChange={(event) => onCwd(event.target.value)} />
          <button className="secondary" disabled={busy === "cwd"}>{t("Save", "保存")}</button>
        </form>
      </div>
    </section>
  );
}

function Voice({ transcriptions }: { transcriptions: Snapshot["transcriptions"] }): ReactElement {
  const t = useT();
  return (
    <section className="wide-panel voice-history">
      <div className="panel-head">
        <div>
          <span className="section-label">{t("TRANSCRIPTION HISTORY", "转写历史")}</span>
          <h2>{t("Voice", "语音")}</h2>
          <p>{t("Recognized speech is kept here with its entry point. Vibe Mic raw audio is never saved.", "识别出的语音会与来源一起保存在这里；Vibe Mic 原始音频不会保存。")}</p>
        </div>
      </div>
      {transcriptions.length ? (
        <div className="voice-history-list">
          {transcriptions.map((item, index) => (
            <article className="voice-history-row" key={`${item.at}-${index}`}>
              <span className={`voice-source ${item.source}`}>{item.source === "yolo" ? "YOLO" : "Agent CLI"}</span>
              <p>{item.text}</p>
              <time>{formatTime(item.at)}</time>
            </article>
          ))}
        </div>
      ) : <Empty text={t("New Agent CLI and YOLO transcriptions will appear here.", "新的 Agent CLI 和 YOLO 转写会显示在这里。")} />}
    </section>
  );
}
function Settings(props: {
  data: Snapshot;
  apiBase: string;
  onlineModel: string;
  localModel: string;
  localModelStatus: LocalModelStatus;
  asrMode: "local" | "online";
  apiKey: string;
  micButtonA: string;
  micButtonB: string;
  micBindingFeedback: MicBindingFeedback;
  saving: boolean;
  busy?: string;
  testing?: "asr" | "yolo";
  theme: ThemePreference;
  language: LanguagePreference;
  desktopShell: boolean;
  loginEnabled?: boolean;
  onApiBase(v: string): void;
  onTheme(v: ThemePreference): void;
  onLanguage(v: LanguagePreference): void;
  onOnlineModel(v: string): void;
  onLocalModel(v: string): void;
  onDownloadLocalModel(): void;
  onAsrMode(v: "local" | "online"): void;
  onApiKey(v: string): void;
  onMicButtonA(v: string): void;
  onMicButtonB(v: string): void;
  onSaveMicBindings(e: FormEvent): void;
  onSaveAsr(e: FormEvent): void;
  onTestAsr(): void;
  onTestYolo(): void;
  onRestart(): void;
  onLogin(v: "install" | "uninstall"): void;
}): ReactElement {
  const t = useT();
  const { data } = props;
  const [sticks, setSticks] = useState<{ name: string; address: string; rssi?: number | null; paired?: boolean; connected?: boolean }[]>([]);
  const [deviceBusy, setDeviceBusy] = useState<"scan" | string>();
  const [deviceError, setDeviceError] = useState("");
  const deviceRequest = async (path: string, address?: string): Promise<Response> => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 35_000);
    try {
      return await fetch(`http://127.0.0.1:7861${path}`, { method: "POST", ...(address ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ address }) } : {}), signal: controller.signal });
    } finally { window.clearTimeout(timer); }
  };
  const scan = async (): Promise<void> => {
    setDeviceBusy("scan");
    try {
      const response = await deviceRequest("/api/devices/scan");
      const result = await response.json() as { devices?: { name: string; address: string; rssi?: number | null; paired?: boolean; connected?: boolean }[]; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Scan failed");
      setSticks(result.devices ?? []);
      setDeviceError("");
    } catch (error) { setDeviceError(error instanceof Error ? error.message : "Scan failed"); }
    finally { setDeviceBusy(undefined); }
  };
  const loadPaired = async (): Promise<void> => {
    try {
      const response = await fetch("http://127.0.0.1:7861/api/devices/paired");
      const result = await response.json() as { devices?: { name: string; address: string; rssi?: number | null; paired?: boolean; connected?: boolean }[]; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Could not load paired devices");
      setSticks(result.devices ?? []);
      setDeviceError("");
    } catch (error) { setDeviceError(error instanceof Error ? error.message : "Could not load paired devices"); }
  };
  useEffect(() => { void loadPaired(); }, []);
  const selectStick = async (address: string): Promise<void> => {
    setDeviceBusy(address);
    try {
      const response = await deviceRequest("/api/devices/connect", address);
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(result.error ?? "Connect failed");
      }
      setDeviceError("");
    } catch (error) { setDeviceError(error instanceof Error ? error.message : "Connect failed"); }
    finally { setDeviceBusy(undefined); }
  };
  const pairAndUse = async (address: string): Promise<void> => {
    setDeviceBusy(address);
    try {
      const paired = await deviceRequest("/api/devices/pair", address);
      if (!paired.ok) {
        const result = await paired.json().catch(() => ({})) as { error?: string };
        throw new Error(result.error ?? "Pairing failed");
      }
      const connected = await deviceRequest("/api/devices/connect", address);
      if (!connected.ok) {
        const result = await connected.json().catch(() => ({})) as { error?: string };
        throw new Error(result.error ?? "Pairing succeeded but connection failed");
      }
      await scan();
      setDeviceError("");
    } catch (error) { setDeviceError(error instanceof Error && error.name === "AbortError" ? t("Pairing timed out. Confirm Bluetooth is enabled, then scan again.", "配对超时。请确认蓝牙已开启后重新扫描。") : error instanceof Error ? error.message : t("Pairing failed", "配对失败")); }
    finally { setDeviceBusy(undefined); }
  };
  const unpair = async (address: string): Promise<void> => {
    setDeviceBusy(address);
    try {
      const response = await deviceRequest("/api/devices/unpair", address);
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(result.error ?? "Remove failed");
      }
      await loadPaired();
      setDeviceError("");
    } catch (error) { setDeviceError(error instanceof Error ? error.message : "Remove failed"); }
    finally { setDeviceBusy(undefined); }
  };
  const yolo = data.environment.capabilities.yolo;
  return (
    <section className="settings-view">
      <div className="settings-heading">
        <div>
          <h2>{t("Settings", "设置")}</h2>
          <p className="lede">{t("Manage your Stick and how Vibe Stick runs on this computer.", "管理设备以及 Vibe Stick 在此电脑上的运行方式。")}</p>
        </div>
        <div className="settings-actions">
          <a
            className="secondary"
            href="http://127.0.0.1:7861/api/diagnostics"
            download
          >
            {t("Download diagnostics", "下载诊断信息")}
          </a>
          {props.desktopShell && (
            <button
              className="quiet"
              onClick={props.onRestart}
              disabled={props.busy === "restart"}
            >
              {props.busy === "restart" ? t("Restarting…", "正在重启…") : t("Restart host", "重启主机")}
            </button>
          )}
        </div>
      </div>
      <section className="setup-section">
        <div><span className="section-label">{t("DEVICE SETUP", "设备设置")}</span><h3>{t("VibeStick devices", "VibeStick 设备")}</h3><p>{t("Manage paired Sticks and their connection state.", "管理已配对设备及其连接状态。")}</p></div>
        {data.environment.owner === "active" && <div className="device-manager"><DeviceImage model={data.device.model} /><div><b>{data.device.name || deviceName(data.device.model)}</b><span><i className="online" />{t("Connected", "已连接")}</span><small>{data.device.firmware || t("Firmware detected automatically", "自动检测固件版本")}</small></div></div>}
        <button className="quiet" onClick={() => void scan()} disabled={deviceBusy === "scan"}>{deviceBusy === "scan" ? t("Scanning…", "正在扫描…") : `+ ${t("Scan for Sticks", "扫描设备")}`}</button>
        {deviceError && <p className="notice">{deviceError}</p>}
        {sticks.map((stick) => <div className="device-manager" key={stick.address}><div /><div><b>{stick.name}</b><span><i className={stick.connected ? "online" : "warn"} />{stick.connected ? t("Active on this host", "此主机当前使用") : stick.paired ? t("Paired · ready to connect", "已配对 · 可连接") : t("Nearby · not paired", "附近 · 未配对")}</span><small>{stick.address}{typeof stick.rssi === "number" ? ` · ${stick.rssi} dBm` : ""} · {stick.connected ? (data.device.model || t("Identifying…", "正在识别型号…")) : t("Model identified on first connection", "首次连接后识别型号")}</small></div><div className="device-actions"><button className="secondary" onClick={() => void (stick.paired ? selectStick(stick.address) : pairAndUse(stick.address))} disabled={Boolean(deviceBusy)}>{deviceBusy === stick.address ? t("Working…", "处理中…") : stick.connected ? t("Reconnect", "重新连接") : stick.paired ? t("Use this Stick", "使用此设备") : t("Pair & Use", "配对并使用")}</button><button className="quiet" onClick={() => void unpair(stick.address)} disabled={Boolean(deviceBusy)}>{t("Remove", "移除")}</button></div></div>)}
      </section>
      <section className="setup-section host-setup">
        <span className="section-label">{t("HOST SETUP", "主机设置")}</span>
        <div className="form-block inline language-setting"><div><h3>{t("App language", "应用语言")}</h3><p>{t("Choose a display language, or follow the system setting.", "选择显示语言，或跟随系统设置。")}</p></div><select value={props.language} onChange={(event) => props.onLanguage(event.target.value as LanguagePreference)} aria-label={t("App language", "应用语言")}><option value="system">{t("Follow system", "跟随系统")}</option><option value="en">English</option><option value="zh">中文</option></select></div>
      </section>
      <div className="form-block inline theme-setting">
        <div>
          <h3>{t("Appearance", "外观")}</h3>
          <p>{t("Choose how Vibe Stick looks on this computer.", "选择 Vibe Stick 在此电脑上的显示样式。")}</p>
        </div>
        <select value={props.theme} onChange={(e) => props.onTheme(e.target.value as ThemePreference)} aria-label={t("Appearance", "外观")}>
          <option value="system">{t("Follow system", "跟随系统")}</option>
          <option value="light">{t("Light", "亮色")}</option>
          <option value="dark">{t("Dark", "暗色")}</option>
        </select>
      </div>
      <form className="form-block" onSubmit={props.onSaveAsr}>
        <h3>{t("Speech recognition", "语音识别")}</h3>
        <p className="asr-intro">{t("Choose where Vibe Stick transcribes device audio. Local is the default and needs no account.", "选择设备音频的转写方式；默认使用本地识别，无需账号。")}</p>
        <div className="asr-mode" role="radiogroup" aria-label={t("ASR mode", "语音识别模式")}>
          <button type="button" className={props.asrMode === "local" ? "selected" : ""} aria-pressed={props.asrMode === "local"} onClick={() => props.onAsrMode("local")}><b>{t("Local", "本地")}</b><span>{t("On this computer", "在此电脑上运行")}</span></button>
          <button type="button" className={props.asrMode === "online" ? "selected" : ""} aria-pressed={props.asrMode === "online"} onClick={() => props.onAsrMode("online")}><b>{t("Online", "在线")}</b><span>{t("OpenAI-compatible API", "兼容 OpenAI 的 API")}</span></button>
        </div>
        {props.asrMode === "local" ? <>
          <label>{t("Local model", "本地模型")}<select value={props.localModel} onChange={(e) => props.onLocalModel(e.target.value)}><option value="tiny">Tiny — {t("fastest", "最快")}</option><option value="base">Base</option><option value="small">Small — {t("recommended", "推荐")}</option><option value="medium">Medium — {t("highest quality", "最高质量")}</option></select></label>
          <div className="asr-local-note">{t("Audio stays on this computer. Download the selected model first, then apply it. Large models can take several minutes.", "音频保留在本机。请先下载所选模型，再点击应用；大型模型可能需要数分钟。")}</div>
          <div className={`model-download ${props.localModelStatus.state}`}>
            <div className="model-download-head"><span>{modelStatusLabel(props.localModelStatus, props.localModel, t)}</span><b>{props.localModelStatus.model === props.localModel && props.localModelStatus.state === "downloading" ? `${Math.round(props.localModelStatus.progress)}%` : ""}</b></div>
            <div className="model-progress" role="progressbar" aria-label={t("Model download progress", "模型下载进度")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={props.localModelStatus.model === props.localModel ? props.localModelStatus.progress : 0}><i style={{ width: `${props.localModelStatus.model === props.localModel ? props.localModelStatus.progress : 0}%` }} /></div>
            {props.localModelStatus.detail && props.localModelStatus.model === props.localModel && <small>{props.localModelStatus.detail}</small>}
          </div>
          <button type="button" className="secondary model-download-button" onClick={props.onDownloadLocalModel} disabled={props.localModelStatus.state === "downloading" || props.localModelStatus.state === "applying"}>{props.localModelStatus.state === "downloading" && props.localModelStatus.model === props.localModel ? t("Downloading…", "正在下载…") : `${t("Download", "下载")} ${props.localModel}`}</button>
        </> : <>
          <label>{t("API base", "API 地址")}<input value={props.apiBase} onChange={(e) => props.onApiBase(e.target.value)} /></label>
          <label>{t("Model", "模型")}<input value={props.onlineModel} onChange={(e) => props.onOnlineModel(e.target.value)} /></label>
          <label>{t("API key", "API 密钥")}<input type="password" value={props.apiKey} placeholder={t("Leave blank to keep it", "留空以保留现有密钥")} onChange={(e) => props.onApiKey(e.target.value)} /></label>
        </>}
        <div className="form-actions">
          <button className="primary" disabled={props.saving || (props.asrMode === "local" && (props.localModelStatus.state === "downloading" || props.localModelStatus.state === "applying"))}>{props.saving ? (props.asrMode === "local" ? t("Applying model…", "正在应用模型…") : t("Saving…", "正在保存…")) : props.asrMode === "local" ? `${t("Apply", "应用")} ${props.localModel}` : t("Use Online ASR", "使用在线 ASR")}</button>
          {props.asrMode === "online" && <button type="button" className="secondary" onClick={props.onTestAsr} disabled={props.testing === "asr"}>{props.testing === "asr" ? t("Testing…", "正在测试…") : t("Test provider", "测试服务")}</button>}
        </div>
      </form>
      <form className="form-block inline" onSubmit={props.onSaveMicBindings}>
        <div><h3>{t("Vibe Mic buttons", "Vibe Mic 按键")}</h3><p>{t("Buttons can emit F1–F24, optionally with Ctrl, Alt, or Shift, while Vibe Mic is active. Examples: Ctrl+F2, Alt+F14, Ctrl+Alt+F8.", "仅在 Vibe Mic 激活时发送 F1–F24，且可组合 Ctrl、Alt 或 Shift。示例：Ctrl+F2、Alt+F14、Ctrl+Alt+F8。")}</p></div>
        <label>{t("Button A", "按键 A")}<ShortcutPicker value={props.micButtonA} onChange={props.onMicButtonA} t={t} /></label>
        <label>{t("Button B", "按键 B")}<ShortcutPicker value={props.micButtonB} onChange={props.onMicButtonB} t={t} /></label>
        <button className="secondary" disabled={props.busy === "mic-bindings"}>{props.busy === "mic-bindings" ? t("Saving…", "正在保存…") : t("Save", "保存")}</button>
        {props.micBindingFeedback.state !== "idle" && <div className={`shortcut-save-status ${props.micBindingFeedback.state}`} role="status">{props.micBindingFeedback.text}</div>}
      </form>
      {yolo?.testable && (
        <div className="form-block inline">
          <div>
            <h3>{t("YOLO permission", "YOLO 权限")}</h3>
            <p>{t("Check whether Vibe Stick can type into the focused app.", "检查 Vibe Stick 是否可以向当前应用输入文字。")}</p>
          </div>
          <button
            className="secondary"
            onClick={props.onTestYolo}
            disabled={props.testing === "yolo"}
          >
            {props.testing === "yolo" ? t("Testing…", "正在测试…") : t("Test permission", "测试权限")}
          </button>
        </div>
      )}
      {props.desktopShell && (
        <div className="form-block inline">
          <div>
            <h3>{t("Start at login", "登录时启动")}</h3>
            <p>
              {props.loginEnabled ? t("Enabled for this user.", "已为当前用户启用。") : t("Not enabled.", "尚未启用。")}
            </p>
          </div>
          <button
            className="secondary"
            disabled={props.busy === "install" || props.loginEnabled}
            onClick={() => void props.onLogin("install")}
          >
            {t("Enable", "启用")}
          </button>
          <button
            className="quiet"
            disabled={props.busy === "uninstall" || !props.loginEnabled}
            onClick={() => void props.onLogin("uninstall")}
          >
            {t("Remove", "移除")}
          </button>
        </div>
      )}
    </section>
  );
}
function ShortcutPicker({ value, onChange, t }: { value: string; onChange: (value: string) => void; t: Translate }): ReactElement {
  const parts = value.split("+");
  const key = parts.find((part) => /^F(?:[1-9]|1\d|2[0-4])$/.test(part)) ?? "F1";
  const update = (nextKey = key, nextParts = parts) => {
    const modifiers = ["Ctrl", "Alt", "Shift"].filter((modifier) => nextParts.includes(modifier));
    onChange([...modifiers, nextKey].join("+"));
  };
  return <div className="shortcut-picker">
    <select aria-label={t("Function key", "功能键")} value={key} onChange={(event) => update(event.target.value)}>
      {Array.from({ length: 24 }, (_, index) => <option key={index} value={`F${index + 1}`}>{`F${index + 1}`}</option>)}
    </select>
    <div className="shortcut-modifiers">
      {["Ctrl", "Alt", "Shift"].map((modifier) => <label key={modifier}>
        <input type="checkbox" checked={parts.includes(modifier)} onChange={(event) => update(key, event.target.checked ? [...parts, modifier] : parts.filter((part) => part !== modifier))} />
        {modifier === "Ctrl" ? "Ctrl" : modifier === "Alt" ? "Alt" : t("Shift", "Shift")}
      </label>)}
    </div>
  </div>;
}
function modelStatusLabel(status: LocalModelStatus, selected: string, t: Translate): string {
  if (status.model !== selected || status.state === "idle") return t("Not downloaded in this session", "本次运行尚未下载");
  return {
    downloading: `${t("Downloading", "正在下载")} ${selected}`,
    ready: `${selected} ${t("downloaded", "已下载")}`,
    applying: `${t("Applying", "正在应用")} ${selected}`,
    applied: `${selected} ${t("applied", "已应用")}`,
    error: `${selected} ${t("needs attention", "需要处理")}`,
    idle: t("Not downloaded in this session", "本次运行尚未下载"),
  }[status.state];
}
const agentSymbols: Record<string, string> = {
  "claude-code": "✺",
  codex: "◉",
  opencode: "›_",
  "kimi-cli": "✦",
};
function agentName(agents: Agent[], id: string | null): string {
  return agents.find((agent) => agent.id === id)?.name ?? id ?? "Agent";
}
function sessionTitle(session: Session, t: Translate = (english) => english): string {
  return session.name?.trim() || session.session?.trim() || t("Untitled session", "未命名会话");
}
function AgentBar({
  agents,
  selected,
  onSelect,
}: {
  agents: Agent[];
  selected: string | null;
  onSelect(id: string): void;
}): ReactElement {
  return (
    <div className="agent-bar" role="tablist" aria-label="Agent CLI">
      <>
        {agents.map((agent) => (
          <button
            role="tab"
            aria-selected={agent.id === selected}
            className={
              agent.id === selected
                ? `agent-tab selected ${agent.id}`
                : `agent-tab ${agent.id}`
            }
            key={agent.id}
            onClick={() => onSelect(agent.id)}
          >
            <span>{agentSymbols[agent.id] ?? "›_"}</span>
            <b>{agent.name}</b>
            <i className={`agent-state ${agent.state}`} />
          </button>
        ))}
      </>
    </div>
  );
}
function Status({ state }: { state: string }): ReactElement {
  return <i className={`status ${state}`} />;
}
function formatTime(value: number): string {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function Empty({ text }: { text: string }): ReactElement {
  return <div className="empty">{text}</div>;
}
