import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

type Page = "overview" | "sessions" | "settings";
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
  const [saving, setSaving] = useState(false);
  const [launcher, setLauncher] = useState<"auto" | "tmux" | "zellij">("auto");
  const [cwdTool, setCwdTool] = useState("");
  const [cwd, setCwd] = useState("");
  const [loginEnabled, setLoginEnabled] = useState<boolean>();
  const [busy, setBusy] = useState<string>();
  const [testing, setTesting] = useState<"asr" | "yolo">();
  const initialized = useRef(false);
  useEffect(() => {
    document.title = "VibeConn";
    if (isTauri()) void getCurrentWindow().setTitle("VibeConn");
  }, []);
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
            label="Agent CLI"
            icon="▤"
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
          <i className={connected ? "online" : ""} />
          {connected ? "Host reachable" : "Host offline"}
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
            onSessions={() => setPage("sessions")}
            onTool={(id) => void send("tool.select", id)}
            onNew={() => void send("session.new")}
          />
        )}
        {page === "sessions" && (
          <Sessions
            data={data}
            onSelect={(id) => void send("session.select", id)}
            onTool={(id) => void send("tool.select", id)}
            onNew={() => void send("session.new")}
          />
        )}
        {page === "settings" && (
          <Settings
            data={data}
            apiBase={apiBase}
            onlineModel={onlineModel}
            localModel={localModel}
            asrMode={asrMode}
            apiKey={apiKey}
            launcher={launcher}
            cwdTool={cwdTool}
            cwd={cwd}
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
            onSaveAsr={saveAsr}
            onTestAsr={() => void testProvider("asr")}
            onTestYolo={() => void testProvider("yolo")}
            onRestart={() => void restart()}
            onLauncher={setLauncher}
            onSaveLauncher={saveLauncher}
            onCwdTool={(id) => {
              setCwdTool(id);
              setCwd(
                data.environment.config.tools.find((tool) => tool.id === id)
                  ?.cwd ?? "",
              );
            }}
            onCwd={setCwd}
            onSaveCwd={saveCwd}
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
  onSessions,
  onTool,
  onNew,
}: {
  data: Snapshot;
  selected?: Session;
  ownerBlocked: boolean;
  busy?: string;
  onRelease(): void;
  onSessions(): void;
  onTool(id: string): void;
  onNew(): void;
}): ReactElement {
  const caps = data.environment.capabilities;
  const agents = data.tools.list;
  const agentSessions = data.sessions.list.filter(
    (session) => session.tool === data.selected_tool,
  );
  return (
    <>
      <section className="device-card">
        <div className="stick">
          <i />
          <i />
          <b>V</b>
        </div>
        <div className="device-copy">
          <span className="section-label">M5STICKC PLUS</span>
          <h2>VibeStick</h2>
          <p>
            {data.environment.owner === "active"
              ? "Connected and synchronized with VibeConn 2.0."
              : "Ready to become the active VibeConn device."}
          </p>
          <div className="device-facts">
            <span>
              BLE <b>{caps.ble.available ? "Ready" : "Unavailable"}</b>
            </span>
            <span>
              ASR <b>{caps.asr.available ? "Ready" : "Setup needed"}</b>
            </span>
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
          <div className="device-state">
            <b>
              {data.environment.owner === "active" ? "Connected" : "Waiting"}
            </b>
            <span>{data.environment.runtime}</span>
          </div>
        )}
      </section>
      <section className="agent-menu">
        <div className="panel-head">
          <div>
            <span className="section-label">AGENT CLI</span>
            <h2>Choose an agent</h2>
          </div>
          <button className="quiet" onClick={onSessions}>
            Manage sessions →
          </button>
        </div>
        <AgentBar
          agents={agents}
          selected={data.selected_tool}
          onSelect={onTool}
        />
        <div className="agent-session-head">
          <div>
            <b>{agentName(agents, data.selected_tool)}</b>
            <span>
              {agentSessions.length
                ? `${agentSessions.length} session${agentSessions.length === 1 ? "" : "s"}`
                : "No sessions"}
            </span>
          </div>
          <button className="quiet" onClick={onNew}>
            ＋ New session
          </button>
        </div>
        {selected && selected.tool === data.selected_tool ? (
          <button className="selected-session" onClick={onSessions}>
            <Status state={selected.state} />
            <div>
              <b>{sessionTitle(selected)}</b>
              <span>
                {agentName(agents, selected.tool)} · {selected.last || "Ready"}
              </span>
            </div>
            <em>Open</em>
          </button>
        ) : (
          <Empty text="Start a session for this agent or choose another agent." />
        )}
      </section>
      <section className="split">
        <div className="panel">
          <span className="section-label">STICK MODE</span>
          <h2>Where the Stick is now</h2>
          {data.device_mode === "home" && <p className="lede">Main menu — choose Agent CLI, Vibe Mic, or YOLO on the Stick.</p>}
          <div className="route-list">
            <Route
              name="Agent CLI"
              description="Transcribe, then deliver to the selected session."
              active={data.device_mode === "agent"}
            />
            <Route
              name="Vibe Mic"
              description="Raw audio to your system input device."
              active={data.device_mode === "mic"}
            />
            <Route
              name="YOLO"
              description={
                data.environment.capabilities.yolo?.available
                  ? "Focused-window input is ready."
                  : (data.environment.capabilities.yolo?.reason ??
                    "Focused-window input.")
              }
              active={data.device_mode === "yolo"}
            />
          </div>
        </div>
        <div className="panel">
          <span className="section-label">CURRENT TARGET</span>
          <h2>{selected ? sessionTitle(selected) : "No session selected"}</h2>
          <p className="lede">
            {selected
              ? `Voice from Agent CLI goes to ${agentName(agents, selected.tool)}.`
              : "Choose an agent and a session before delivering a transcript."}
          </p>
        </div>
      </section>
    </>
  );
}
function Sessions({
  data,
  onSelect,
  onTool,
  onNew,
}: {
  data: Snapshot;
  onSelect(id: string): void;
  onTool(id: string): void;
  onNew(): void;
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
    </section>
  );
}
function Voice({ data }: { data: Snapshot }): ReactElement {
  const yolo = data.environment.capabilities.yolo;
  return (
    <section className="wide-panel">
      <span className="section-label">MODE GUIDE</span>
      <h2>Voice modes live on the Stick</h2>
      <p className="lede">
        Select a mode on VibeStick. This view explains exactly where audio and
        text go.
      </p>
      <div className="voice-grid">
        <Mode
          name="Agent CLI"
          icon="⌁"
          detail="Hold A to record. Release, review the transcript, then press A again to deliver it to the selected session."
          state={data.environment.capabilities.asr}
        />
        <Mode
          name="Vibe Mic"
          icon="◉"
          detail="A sends F15 and raw audio to the system Vibe Mic input. B sends F14."
          state={data.environment.capabilities.mic}
        />
        <Mode
          name="YOLO"
          icon="◎"
          detail="Transcribe into the currently focused application. A confirms Enter; B sends Escape twice."
          state={yolo}
        />
      </div>
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
  launcher: "auto" | "tmux" | "zellij";
  cwdTool: string;
  cwd: string;
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
  onSaveAsr(e: FormEvent): void;
  onTestAsr(): void;
  onTestYolo(): void;
  onRestart(): void;
  onLauncher(v: "auto" | "tmux" | "zellij"): void;
  onSaveLauncher(e: FormEvent): void;
  onCwdTool(v: string): void;
  onCwd(v: string): void;
  onSaveCwd(e: FormEvent): void;
  onLogin(v: "install" | "uninstall"): void;
}): ReactElement {
  const { data } = props;
  const yolo = data.environment.capabilities.yolo;
  return (
    <section className="settings-view">
      <div className="settings-heading">
        <div>
          <span className="section-label">HOST SETUP</span>
          <h2>Settings</h2>
          <p className="lede">VibeConn 1.x and 2.0 share this configuration.</p>
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
      <form className="form-block inline" onSubmit={props.onSaveLauncher}>
        <div>
          <h3>New-session launcher</h3>
          <p>Choose where Stick-created sessions open.</p>
        </div>
        <select
          value={props.launcher}
          onChange={(e) =>
            props.onLauncher(e.target.value as "auto" | "tmux" | "zellij")
          }
        >
          <option value="auto">Auto</option>
          <option value="tmux">tmux</option>
          <option value="zellij">zellij</option>
        </select>
        <button className="secondary" disabled={props.busy === "launcher"}>
          Save
        </button>
      </form>
      <form className="form-block inline" onSubmit={props.onSaveCwd}>
        <div>
          <h3>Working directory</h3>
          <p>Used only for newly created Agent CLI sessions.</p>
        </div>
        <select
          value={props.cwdTool}
          onChange={(e) => props.onCwdTool(e.target.value)}
        >
          {data.environment.config.tools.map((tool) => (
            <option key={tool.id} value={tool.id}>
              {tool.name}
            </option>
          ))}
        </select>
        <input
          value={props.cwd}
          placeholder="Empty: inherit pane / home"
          onChange={(e) => props.onCwd(e.target.value)}
        />
        <button className="secondary" disabled={props.busy === "cwd"}>
          Save
        </button>
      </form>
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
