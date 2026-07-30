import {
  useEffect,
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
  device: { model: string; firmware: string };
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
  device: { model: "M5StickC-Plus", firmware: "" },
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
      ble: { available: false, reason: "Start VibeConn 2.0" },
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
  const [apiBase, setApiBase] = useState(demo.environment.config.asr_api_base);
  const [onlineModel, setOnlineModel] = useState(
    demo.environment.config.asr_online_model ?? "",
  );
  const [localModel, setLocalModel] = useState(
    demo.environment.config.asr_model,
  );
  const [asrMode, setAsrMode] = useState<"local" | "online">("local");
  const [asrDirty, setAsrDirty] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [micButtonA, setMicButtonA] = useState("F14");
  const [micButtonB, setMicButtonB] = useState("F15");
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
    document.title = "VibeConn";
    if (isTauri()) void getCurrentWindow().setTitle("VibeConn");
  }, []);
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
    setApiBase(data.environment.config.asr_api_base);
    setOnlineModel(
      data.environment.config.asr_online_model ??
        data.environment.config.asr_model,
    );
    setLocalModel(
      data.environment.config.asr_engine === "online"
        ? localModel
        : data.environment.config.asr_model,
    );
    if (!asrDirty)
      setAsrMode(
        data.environment.config.asr_engine === "online" ? "online" : "local",
      );
    setLauncher(data.environment.config.session_launcher);
    setMicButtonA(data.environment.config.mic_button_a ?? "F14");
    setMicButtonB(data.environment.config.mic_button_b ?? "F15");
    if (!initialized.current && data.environment.config.tools.length) {
      const tool = data.environment.config.tools[0]!;
      setCwdTool(tool.id);
      setCwd(tool.cwd);
      initialized.current = true;
    }
  }, [data.environment.config, asrDirty]);
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
      setNotice("This action needs a running VibeConn host.");
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
        "Python 1.x released BLE. Host 2.0 will retry the connection shortly.",
      );
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Could not release the Python 1.x owner.",
      );
    } finally {
      setBusy(undefined);
    }
  };
  const saveAsr = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSaving(true);
    try {
      const response = await fetch("http://127.0.0.1:7861/api/settings/asr", {
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
      if (!response.ok) throw new Error("Save failed");
      setApiKey("");
      setAsrDirty(false);
      setNotice("ASR mode saved. Restart VibeConn 2.0 to apply it.");
    } catch {
      setNotice("Could not save ASR settings.");
    } finally {
      setSaving(false);
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
      setNotice("New-session launcher saved.");
    } catch {
      setNotice("Could not save launcher.");
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
      setNotice("Working directory saved.");
    } catch {
      setNotice("Could not save directory.");
    } finally {
      setBusy(undefined);
    }
  };
  const saveMicBindings = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy("mic-bindings");
    try {
      const response = await fetch("http://127.0.0.1:7861/api/settings/mic-bindings", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ button_a: micButtonA, button_b: micButtonB }),
      });
      if (!response.ok) throw new Error();
      setNotice("Vibe Mic buttons saved. Restart VibeConn 2.0 to send them to the Stick.");
    } catch { setNotice("Could not save Vibe Mic button bindings."); }
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
          : "Could not update startup registration.",
      );
    } finally {
      setBusy(undefined);
    }
  };
  const restart = async (): Promise<void> => {
    setBusy("restart");
    try {
      if (!isTauri())
        throw new Error("Restart is available from the VibeConn desktop app.");
      setNotice((await invoke<{ detail: string }>("restart_host")).detail);
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Could not restart VibeConn 2.0.",
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
    overview: "Overview",
    sessions: "Sessions",
    voice: "Voice",
    settings: "Settings",
  };
  return (
    <main className="vibe-app">
      <aside className="rail">
        <button className="wordmark" onClick={() => setPage("overview")}>
          <span>V</span>
          <b>VibeConn</b>
          <small>2.0</small>
        </button>
        <nav aria-label="Primary navigation">
          <Nav
            page={page}
            target="overview"
            label="Overview"
            icon="⌂"
            onClick={setPage}
          />
          <Nav
            page={page}
            target="sessions"
            label="Sessions"
            icon="▤"
            onClick={setPage}
          />
          <Nav
            page={page}
            target="voice"
            label="Voice"
            icon="◌"
            onClick={setPage}
          />
          <Nav
            page={page}
            target="settings"
            label="Settings"
            icon="⚙"
            onClick={setPage}
          />
        </nav>
        <div className="rail-status">
          {connected ? "VibeConn desktop" : "Connecting to host…"}
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
                ? "VibeStick connected"
                : ownerBlocked
                  ? "Handoff required"
                  : "Standby"}
            </span>
          </div>
        </header>
        {notice && (
          <div className="notice">
            <span>{notice}</span>
            <button onClick={() => setNotice("")} aria-label="Dismiss">
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
            asrMode={asrMode}
            apiKey={apiKey}
            micButtonA={micButtonA}
            micButtonB={micButtonB}
            saving={saving}
            busy={busy}
            testing={testing}
            theme={theme}
            desktopShell={isTauri()}
            loginEnabled={loginEnabled}
            onApiBase={setApiBase}
            onTheme={setTheme}
            onOnlineModel={setOnlineModel}
            onLocalModel={setLocalModel}
            onAsrMode={(mode) => {
              setAsrMode(mode);
              setAsrDirty(true);
            }}
            onApiKey={setApiKey}
            onMicButtonA={setMicButtonA}
            onMicButtonB={setMicButtonB}
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
  const caps = data.environment.capabilities;
  const agents = data.tools.list;
  return (
    <div className="overview-dashboard">
      <section className="device-card dashboard-hero">
        <DeviceImage model={data.device.model} />
        <div className="device-copy">
          <span className="section-label">STICK STATUS</span>
          <h2>{deviceName(data.device.model)}</h2>
          <p>
            {data.environment.owner === "active"
              ? "Connected, synchronized, and ready for voice input."
              : "Waiting to become the active VibeConn device."}
          </p>
          <div className="device-facts">
            <StatusFact label="BLE" value={caps.ble.available ? "Ready" : "Unavailable"} />
            <StatusFact label="ASR" value={caps.asr.available ? "Ready" : "Setup needed"} />
            <StatusFact label="Mode" value={modeName(data.device_mode)} />
            {data.device.firmware && <StatusFact label="Firmware" value={data.device.firmware} />}
          </div>
        </div>
        {ownerBlocked ? (
          <div className="handoff-panel">
            <span>Python 1.x owns the Stick</span>
            <p>Release it once; VibeConn 2.0 will reconnect automatically.</p>
            <button
              className="primary"
              onClick={onRelease}
              disabled={busy === "release"}
            >
              {busy === "release" ? "Releasing…" : "Release to VibeConn 2.0"}
            </button>
          </div>
        ) : (
          <div className="device-state device-actions">
            <b>{data.environment.owner === "active" ? "Connected" : "Waiting"}</b>
            <span>{data.environment.runtime}</span>
            <button className="secondary" onClick={onReconnect} disabled={busy === "restart"}>
              {busy === "restart" ? "Reconnecting…" : "Reconnect"}
            </button>
          </div>
        )}
      </section>
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
  const rows = data.transcriptions.slice(0, 6).map((item) => ({ at: item.at, mode: item.source === "yolo" ? "YOLO" : "Agent", text: item.text }));
  if (!rows.length && selected) rows.push({ at: 0, mode: modeName(data.device_mode), text: selected.last || "Ready for your next prompt" });
  return <section className="panel live-activity"><div className="panel-head"><div><span className="section-label">LIVE ACTIVITY</span><h2>Latest</h2></div></div>{rows.length ? <div className="latest-list">{rows.map((row, index) => <article className="latest-row" key={`${row.at}-${index}`}><time>{row.at ? formatTime(row.at) : "Now"}</time><span>Latest ·</span><b className={`mode-chip ${row.mode.toLowerCase().replaceAll(" ", "-")}`}>{row.mode}</b><p>{row.text}</p></article>)}</div> : <Empty text="Activity from the Stick will appear here." />}</section>;
}
function CurrentTarget({ data, selected, agents }: { data: Snapshot; selected?: Session; agents: Agent[] }): ReactElement {
  return <section className="panel current-target"><span className="section-label">CURRENT TARGET</span><div className="target-mark">›_</div><h2>{currentTarget(data, selected)}</h2><p className="lede">{targetDetail(data, selected, agents)}</p><div className="target-mode"><i className={data.environment.owner === "active" ? "online" : "warn"} />{modeName(data.device_mode)}</div></section>;
}
function deviceName(model: string): string {
  return model === "M5StickS3" ? "M5StickS3" : "M5StickC Plus";
}
function DeviceImage({ model }: { model: string }): ReactElement {
  if (model === "M5StickS3") return <div className="stick stick-s3" aria-label="M5StickS3 product image"><img src={stickS3Image} alt="M5StickS3" /></div>;
  return <div className="stick stick-cplus" aria-label="M5StickC Plus product image"><img src={stickCPlusImage} alt="M5StickC Plus" /></div>;
}
function ModeRow({ name, detail, active }: { name: string; detail: string; active: boolean }): ReactElement {
  return <div className={active ? "mode-row active" : "mode-row"}><i /><div><b>{name}</b><span>{detail}</span></div>{active && <em>Now</em>}</div>;
}
function modeName(mode: Snapshot["device_mode"]): string {
  return mode === "agent" ? "Agent CLI" : mode === "mic" ? "Vibe Mic" : mode === "yolo" ? "YOLO" : "Main menu";
}
function currentTarget(data: Snapshot, selected?: Session): string {
  if (data.device_mode === "mic" || data.device_mode === "yolo")
    return data.foreground_target?.app ?? "Detecting focused application…";
  return selected ? sessionTitle(selected) : "No session selected";
}
function targetDetail(data: Snapshot, selected: Session | undefined, agents: Agent[]): string {
  if (data.device_mode === "mic")
    return data.foreground_target
      ? "Foreground application only — its window content is not read or shown."
      : "Move the cursor to an application window to identify it. Window content is never read."
  if (data.device_mode === "yolo")
    return data.foreground_target
      ? "YOLO sends text to this focused application. Window content is not read or shown."
      : "Move the cursor to the intended application window before using YOLO."
  return selected
    ? `${agentName(agents, selected.tool)} · ${selected.last || "Ready for your next prompt"}`
    : "Select an Agent CLI session in Sessions before sending a transcript.";
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
  const sessions = data.sessions.list.filter(
    (session) => session.tool === data.selected_tool,
  );
  return (
    <section className="wide-panel">
      <div className="panel-head">
        <div>
          <span className="section-label">AGENT CLI</span>
          <h2>Sessions</h2>
          <p>
            Choose an agent first, then select where its transcripts are
            delivered.
          </p>
        </div>
        <button className="primary" onClick={onNew}>
          ＋ New session
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
                <b>{sessionTitle(session)}</b>
                <span>
                  {agentName(data.tools.list, session.tool)}
                  {session.last ? ` · ${session.last}` : ""}
                </span>
              </div>
              <em>
                {session.id === data.active_session
                  ? "Selected"
                  : session.state === "idle"
                    ? "Ready"
                    : session.state}
              </em>
            </button>
          ))
        ) : (
          <Empty
            text={`No ${agentName(data.tools.list, data.selected_tool)} session is available yet.`}
          />
        )}
      </div>
      <div className="session-preferences">
        <div>
          <span className="section-label">SESSION PREFERENCES</span>
          <h3>New sessions</h3>
          <p className="lede">Controls where Stick-created Agent CLI sessions open.</p>
        </div>
        <form className="form-block inline" onSubmit={onSaveLauncher}>
          <div><h3>Launcher</h3><p>Terminal multiplexer for new sessions.</p></div>
          <select value={launcher} onChange={(event) => onLauncher(event.target.value as "auto" | "tmux" | "zellij")}>
            <option value="auto">Auto</option><option value="tmux">tmux</option><option value="zellij">zellij</option>
          </select>
          <button className="secondary" disabled={busy === "launcher"}>Save</button>
        </form>
        <form className="form-block inline" onSubmit={onSaveCwd}>
          <div><h3>Working directory</h3><p>Used when a new session is created for this Agent CLI.</p></div>
          <select value={cwdTool} onChange={(event) => onCwdTool(event.target.value)}>
            {data.environment.config.tools.map((tool) => <option key={tool.id} value={tool.id}>{tool.name}</option>)}
          </select>
          <input value={cwd} placeholder="Empty: inherit pane / home" onChange={(event) => onCwd(event.target.value)} />
          <button className="secondary" disabled={busy === "cwd"}>Save</button>
        </form>
      </div>
    </section>
  );
}

function Voice({ transcriptions }: { transcriptions: Snapshot["transcriptions"] }): ReactElement {
  return (
    <section className="wide-panel voice-history">
      <div className="panel-head">
        <div>
          <span className="section-label">TRANSCRIPTION HISTORY</span>
          <h2>Voice</h2>
          <p>Recognized speech is kept here with its entry point. Vibe Mic raw audio is never saved.</p>
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
      ) : <Empty text="New Agent CLI and YOLO transcriptions will appear here." />}
    </section>
  );
}
function Settings(props: {
  data: Snapshot;
  apiBase: string;
  onlineModel: string;
  localModel: string;
  asrMode: "local" | "online";
  apiKey: string;
  micButtonA: string;
  micButtonB: string;
  saving: boolean;
  busy?: string;
  testing?: "asr" | "yolo";
  theme: ThemePreference;
  desktopShell: boolean;
  loginEnabled?: boolean;
  onApiBase(v: string): void;
  onTheme(v: ThemePreference): void;
  onOnlineModel(v: string): void;
  onLocalModel(v: string): void;
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
  const { data } = props;
  const yolo = data.environment.capabilities.yolo;
  const [language, setLanguage] = useState("system");
  return (
    <section className="settings-view">
      <div className="settings-heading">
        <div>
          <h2>Settings</h2>
          <p className="lede">Manage your Stick and how VibeConn runs on this computer.</p>
        </div>
        <div className="settings-actions">
          <a
            className="secondary"
            href="http://127.0.0.1:7861/api/diagnostics"
            download
          >
            Download diagnostics
          </a>
          {props.desktopShell && (
            <button
              className="quiet"
              onClick={props.onRestart}
              disabled={props.busy === "restart"}
            >
              {props.busy === "restart" ? "Restarting…" : "Restart host"}
            </button>
          )}
        </div>
      </div>
      <section className="setup-section">
        <div><span className="section-label">DEVICE SETUP</span><h3>VibeStick devices</h3><p>Manage paired Sticks and their connection state.</p></div>
        <div className="device-manager"><DeviceImage model={data.device.model} /><div><b>{deviceName(data.device.model)}</b><span><i className={data.environment.owner === "active" ? "online" : "warn"} />{data.environment.owner === "active" ? "Connected" : "Disconnected"}</span><small>{data.device.firmware || "Firmware detected automatically"}</small></div><button className="secondary" onClick={props.onRestart} disabled={props.busy === "restart"}>{props.busy === "restart" ? "Reconnecting…" : "Reconnect"}</button></div>
        <button className="quiet" onClick={() => window.alert("Pair an additional Stick from your system Bluetooth settings, then open VibeConn to connect it.")}>+ Add Stick</button>
      </section>
      <section className="setup-section host-setup">
        <span className="section-label">HOST SETUP</span>
        <div className="form-block inline language-setting"><div><h3>App language</h3><p>Choose a display language, or follow the system setting.</p></div><select value={language} onChange={(event) => setLanguage(event.target.value)} aria-label="App language"><option value="system">Follow system</option><option value="en">English</option><option value="zh">中文</option></select></div>
      </section>
      <div className="form-block inline theme-setting">
        <div>
          <h3>Appearance</h3>
          <p>Choose how VibeConn looks on this computer.</p>
        </div>
        <select value={props.theme} onChange={(e) => props.onTheme(e.target.value as ThemePreference)} aria-label="Appearance">
          <option value="system">Follow system</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </div>
      <form className="form-block" onSubmit={props.onSaveAsr}>
        <h3>Speech recognition</h3>
        <p className="asr-intro">Choose where VibeConn transcribes Stick audio. Local is the default and needs no account.</p>
        <div className="asr-mode" role="radiogroup" aria-label="ASR mode">
          <button type="button" className={props.asrMode === "local" ? "selected" : ""} aria-pressed={props.asrMode === "local"} onClick={() => props.onAsrMode("local")}><b>Local</b><span>On this computer</span></button>
          <button type="button" className={props.asrMode === "online" ? "selected" : ""} aria-pressed={props.asrMode === "online"} onClick={() => props.onAsrMode("online")}><b>Online</b><span>OpenAI-compatible API</span></button>
        </div>
        {props.asrMode === "local" ? <>
          <label>Local model<select value={props.localModel} onChange={(e) => props.onLocalModel(e.target.value)}><option value="tiny">Tiny — fastest</option><option value="base">Base</option><option value="small">Small — recommended</option><option value="medium">Medium — highest quality</option></select></label>
          <div className="asr-local-note">Audio stays on this computer. The configured local model is used after restart.</div>
        </> : <>
          <label>API base<input value={props.apiBase} onChange={(e) => props.onApiBase(e.target.value)} /></label>
          <label>Model<input value={props.onlineModel} onChange={(e) => props.onOnlineModel(e.target.value)} /></label>
          <label>API key<input type="password" value={props.apiKey} placeholder="Leave blank to keep it" onChange={(e) => props.onApiKey(e.target.value)} /></label>
        </>}
        <div className="form-actions">
          <button className="primary" disabled={props.saving}>{props.saving ? "Saving…" : `Use ${props.asrMode === "local" ? "Local" : "Online"} ASR`}</button>
          {props.asrMode === "online" && <button type="button" className="secondary" onClick={props.onTestAsr} disabled={props.testing === "asr"}>{props.testing === "asr" ? "Testing…" : "Test provider"}</button>}
        </div>
      </form>
      <form className="form-block inline" onSubmit={props.onSaveMicBindings}>
        <div><h3>Vibe Mic buttons</h3><p>Buttons emit configurable F13–F24 keys only while Vibe Mic is active. Default: A = F14, B = F15.</p></div>
        <label>Button A<select value={props.micButtonA} onChange={(e) => props.onMicButtonA(e.target.value)}>{functionKeyOptions()}</select></label>
        <label>Button B<select value={props.micButtonB} onChange={(e) => props.onMicButtonB(e.target.value)}>{functionKeyOptions()}</select></label>
        <button className="secondary" disabled={props.busy === "mic-bindings"}>{props.busy === "mic-bindings" ? "Saving…" : "Save"}</button>
      </form>
      {yolo?.testable && (
        <div className="form-block inline">
          <div>
            <h3>YOLO permission</h3>
            <p>Check whether VibeConn can type into the focused app.</p>
          </div>
          <button
            className="secondary"
            onClick={props.onTestYolo}
            disabled={props.testing === "yolo"}
          >
            {props.testing === "yolo" ? "Testing…" : "Test permission"}
          </button>
        </div>
      )}
      {props.desktopShell && (
        <div className="form-block inline">
          <div>
            <h3>Start at login</h3>
            <p>
              {props.loginEnabled ? "Enabled for this user." : "Not enabled."}
            </p>
          </div>
          <button
            className="secondary"
            disabled={props.busy === "install" || props.loginEnabled}
            onClick={() => void props.onLogin("install")}
          >
            Enable
          </button>
          <button
            className="quiet"
            disabled={props.busy === "uninstall" || !props.loginEnabled}
            onClick={() => void props.onLogin("uninstall")}
          >
            Remove
          </button>
        </div>
      )}
    </section>
  );
}
function functionKeyOptions(): ReactElement[] {
  return Array.from({ length: 12 }, (_, index) => <option key={index} value={`F${index + 13}`}>{`F${index + 13}`}</option>);
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
function sessionTitle(session: Session): string {
  return session.name?.trim() || session.session?.trim() || "Untitled session";
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
function Route({
  name,
  description,
  active,
}: {
  name: string;
  description: string;
  active?: boolean;
}): ReactElement {
  return (
    <div className={active ? "route active" : "route"}>
      <b>{name}</b>
      <span>{description}</span>
      {active && <em>Current</em>}
    </div>
  );
}
function VoiceActivity({ voice, latest }: { voice: Snapshot["voice"]; latest?: Snapshot["transcriptions"][number] }): ReactElement {
  const seconds = (voice.recorded_ms / 1000).toFixed(1);
  const mode = voice.mode === "mic" ? "Vibe Mic" : voice.mode === "yolo" ? "YOLO" : "Agent CLI";
  const heading = voice.state === "recording" ? `Recording · ${mode}` : voice.state === "transcribing" ? "Transcribing" : voice.state === "ready" ? "Transcript ready" : voice.state === "error" ? "Voice error" : "Listening for the Stick";
  const detail = voice.state === "recording" ? `${seconds}s captured from the Stick` : voice.mode === "mic" ? "Raw audio is routed to the system Vibe Mic input." : voice.state === "idle" ? "Hold A on the Stick to begin recording." : "Audio is being processed on the paired host.";
  const displayedText = voice.text || (voice.state === "idle" ? latest?.text : "");
  const displayedSource = voice.text ? voice.mode : latest?.source === "yolo" ? "YOLO" : latest ? "Agent CLI" : "";
  return <section className="panel voice-activity"><div className="voice-copy"><span className="section-label">LIVE ACTIVITY</span><h2>{heading}</h2><p className="lede">{detail}</p></div><span className={`voice-state ${voice.state}`}>{voice.state === "recording" ? `${seconds}s` : mode}</span><div className="voice-wave" aria-label={`Audio level ${Math.round(voice.level * 100)} percent`}>{Array.from({ length: 40 }, (_, index) => <i key={index} style={{ height: `${voice.state === "recording" ? 18 + ((index * 29 + Math.round(voice.level * 100) * 7) % 66) : 16 + ((index * 17) % 32)}%` }} />)}</div>{displayedText && <div className={voice.state === "error" ? "voice-preview error" : "voice-preview"}>{displayedSource && <small>Latest · {displayedSource}</small>}{displayedText}</div>}</section>;
}
function TransferLog({ transfers, status }: { transfers: Snapshot["transfers"]; status: Snapshot["status"] }): ReactElement {
  return <section className="panel transfer-log"><div className="panel-head"><div><span className="section-label">TRANSMISSION RECORD</span><h2>Recent activity</h2></div><span className="transfer-target">{status.state === "idle" ? "Host ready" : status.state}</span></div>{transfers.length ? <div className="transfer-list">{transfers.map((item, index) => <div className="transfer-row" key={`${item.at}-${index}`}><span className={`transfer-kind ${item.kind}`}>{transferLabel(item.kind)}</span><p>{item.text}</p><time>{formatTime(item.at)}</time></div>)}</div> : <Empty text="Voice recordings, transcripts, and deliveries from the Stick will appear here." />}</section>;
}
function transferLabel(kind: Snapshot["transfers"][number]["kind"]): string {
  return { recording: "REC", transcript: "ASR", delivery: "SENT", audio: "AUDIO", error: "ERROR" }[kind];
}
function formatTime(value: number): string {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function Mode({
  name,
  icon,
  detail,
  state,
}: {
  name: string;
  icon: string;
  detail: string;
  state?: Capability;
}): ReactElement {
  return (
    <article className="mode-card">
      <span className="mode-icon">{icon}</span>
      <h3>{name}</h3>
      <p>{detail}</p>
      <small className={state?.available ? "ready" : "needs"}>
        {state?.available ? "Ready" : (state?.reason ?? "Setup required")}
      </small>
    </article>
  );
}
function Empty({ text }: { text: string }): ReactElement {
  return <div className="empty">{text}</div>;
}
