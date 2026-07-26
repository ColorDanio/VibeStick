import { useEffect, useRef, useState, type FormEvent, type ReactElement } from "react";

declare global { interface Window { vibestickDesktop?: { hostStatus(): Promise<{ state: string; detail?: string }>; restartHost(): Promise<{ state: string; detail?: string }>; releasePythonOwner(): Promise<{ ok: boolean; detail: string }>; loginStartup(action: "install" | "uninstall"): Promise<{ ok: boolean; detail: string }>; loginStartupStatus(): Promise<{ enabled: boolean; detail?: string }> }; } }

type Capability = { available: boolean; reason?: string; testable?: boolean };
type Session = { id: string; state: "idle" | "running" | "waiting"; session: string; model: string; last: string; tool: string };
type Snapshot = {
  selected_tool: string | null; active_session: string | null; audio_route: "asr" | "mic"; queued: number;
  status: { state: string; session: string; tool: string; model: string };
  sessions: { list: Session[] };
  tools: { list: { id: string; name: string; state: string }[] };
  environment: { owner: "active" | "inactive"; runtime: string; capabilities: { ble: Capability; keyboard: Capability; mic: Capability; asr: Capability; yolo?: Capability }; traditional_owner: { state: "running" | "unavailable"; detail?: string }; config: { path: string; asr_engine: string; asr_api_base: string; asr_model: string; online_asr_configured: boolean; session_launcher: "auto" | "tmux" | "zellij"; tools: { id: string; name: string; cwd: string }[] }; error?: string };
};

const api = async (path: string, init?: RequestInit): Promise<Snapshot> => {
  const response = await fetch(`http://127.0.0.1:7861${path}`, init);
  if (!response.ok) throw new Error(`Host 2.0 API returned ${response.status}`);
  return response.json() as Promise<Snapshot>;
};

const demo: Snapshot = {
  selected_tool: "opencode", active_session: "design-system", audio_route: "asr", queued: 0,
  status: { state: "idle", session: "Design system", tool: "opencode", model: "" },
  sessions: { list: [
    { id: "design-system", tool: "opencode", state: "idle", session: "Design system", model: "", last: "Ready for your next prompt" },
    { id: "release-notes", tool: "codex", state: "running", session: "Release notes", model: "", last: "Writing the changelog…" },
  ] },
  tools: { list: [{ id: "opencode", name: "OpenCode", state: "ready" }, { id: "codex", name: "Codex", state: "running" }] },
  environment: { owner: "inactive", runtime: "stopped", capabilities: {
    ble: { available: false, reason: "Start the Host 2.0 runtime" }, keyboard: { available: false, reason: "Start the Host 2.0 runtime" }, mic: { available: false, reason: "Start the Host 2.0 runtime" }, asr: { available: false, reason: "Configure online ASR" }, yolo: { available: false, reason: "Start the Host 2.0 runtime" },
  }, traditional_owner: { state: "unavailable" }, config: { path: "~/.vibestick/config.json", asr_engine: "faster-whisper", asr_api_base: "https://api.groq.com/openai/v1", asr_model: "whisper-large-v3-turbo", online_asr_configured: false, session_launcher: "auto", tools: [{ id: "codex", name: "Codex", cwd: "" }] } },
};

export function App(): ReactElement {
  const [data, setData] = useState<Snapshot>(demo);
  const [connected, setConnected] = useState(false);
  const [notice, setNotice] = useState("Host 2.0 is not running — showing a local preview.");
  const [apiBase, setApiBase] = useState(demo.environment.config.asr_api_base);
  const [model, setModel] = useState(demo.environment.config.asr_model);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [testingAsr, setTestingAsr] = useState(false);
  const [testingYolo, setTestingYolo] = useState(false);
  const [launcher, setLauncher] = useState<"auto" | "tmux" | "zellij">(demo.environment.config.session_launcher);
  const [savingLauncher, setSavingLauncher] = useState(false);
  const [cwdTool, setCwdTool] = useState(demo.environment.config.tools[0]?.id ?? "");
  const [cwd, setCwd] = useState("");
  const [savingCwd, setSavingCwd] = useState(false);
  const cwdInitialized = useRef(false);
  const [restartRequired, setRestartRequired] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [releasingOwner, setReleasingOwner] = useState(false);
  const [loginBusy, setLoginBusy] = useState<"install" | "uninstall" | undefined>();
  const [loginStartupEnabled, setLoginStartupEnabled] = useState<boolean | undefined>();

  useEffect(() => {
    let active = true;
    const refresh = async (): Promise<void> => {
      try {
        const snapshot = await api("/api/desktop");
        if (active) {
          setData(snapshot); setConnected(true);
          setNotice(snapshot.environment.error ? `Host 2.0 needs attention: ${snapshot.environment.error}` : snapshot.environment.traditional_owner.state === "running" && snapshot.environment.owner === "inactive" ? `${snapshot.environment.traditional_owner.detail} Stop Python 1.x using the way you started it, then restart Host 2.0 here to hand off BLE safely.` : "");
        }
      }
      catch {
        if (!active) return;
        setConnected(false);
        const native = await window.vibestickDesktop?.hostStatus().catch(() => undefined);
        if (native?.state === "exited") setNotice(`Host 2.0 stopped: ${native.detail ?? "see diagnostics"}`);
        else if (native?.state === "missing") setNotice(`Host 2.0 unavailable: ${native.detail ?? "runtime missing"}`);
      }
    };
    void refresh(); const timer = window.setInterval(() => void refresh(), 1200);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  useEffect(() => {
    let active = true;
    if (!window.vibestickDesktop) return () => { active = false; };
    void window.vibestickDesktop.loginStartupStatus().then((result) => { if (active) setLoginStartupEnabled(result.enabled); }).catch(() => { if (active) setLoginStartupEnabled(undefined); });
    return () => { active = false; };
  }, []);

  useEffect(() => { setApiBase(data.environment.config.asr_api_base); setModel(data.environment.config.asr_model); setLauncher(data.environment.config.session_launcher); }, [data.environment.config.asr_api_base, data.environment.config.asr_model, data.environment.config.session_launcher]);
  useEffect(() => { if (!cwdInitialized.current && data.environment.config.tools.length) { const tool = data.environment.config.tools.find((item) => item.id === cwdTool) ?? data.environment.config.tools[0]; if (tool) { setCwdTool(tool.id); setCwd(tool.cwd); cwdInitialized.current = true; } } }, [data.environment.config.tools, cwdTool]);

  const send = async (cmd: string, id?: string): Promise<void> => {
    try {
      const snapshot = await api("/api/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cmd, ...(id ? { id } : {}) }) });
      setData(snapshot); setNotice("");
    } catch { setNotice("That control needs a running Host 2.0 runtime."); }
  };
  const saveAsr = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); setSaving(true);
    try {
      const response = await fetch("http://127.0.0.1:7861/api/settings/asr", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ api_base: apiBase, model, ...(apiKey ? { api_key: apiKey } : {}) }) });
      const result: unknown = await response.json();
      if (!response.ok) throw new Error(typeof result === "object" && result !== null && typeof (result as { error?: unknown }).error === "string" ? (result as { error: string }).error : "settings save failed");
      setApiKey(""); setRestartRequired(true); setNotice("Online ASR settings saved. Restart Host 2.0 to apply them.");
    } catch (error) { setNotice(`Could not save ASR settings: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setSaving(false); }
  };
  const testAsr = async (): Promise<void> => {
    setTestingAsr(true);
    try {
      const response = await fetch("http://127.0.0.1:7861/api/settings/asr/test", { method: "POST" });
      const result: unknown = await response.json();
      if (!response.ok) throw new Error(typeof result === "object" && result !== null && typeof (result as { error?: unknown }).error === "string" ? (result as { error: string }).error : "provider test failed");
      const modelAvailable = typeof result === "object" && result !== null ? (result as { model_available?: unknown }).model_available : undefined;
      setNotice(modelAvailable === false ? "ASR provider is reachable, but it did not list the configured model." : modelAvailable === true ? "ASR provider and configured model verified." : "ASR provider credentials verified. This provider does not expose a model list.");
    } catch (error) { setNotice(`ASR provider test failed: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setTestingAsr(false); }
  };
  const testYolo = async (): Promise<void> => {
    setTestingYolo(true);
    try {
      const response = await fetch("http://127.0.0.1:7861/api/settings/yolo/test", { method: "POST" });
      const result: unknown = await response.json();
      if (!response.ok) throw new Error(typeof result === "object" && result !== null && typeof (result as { error?: unknown }).error === "string" ? (result as { error: string }).error : "YOLO permission test failed");
      const detail = typeof result === "object" && result !== null && typeof (result as { detail?: unknown }).detail === "string" ? (result as { detail: string }).detail : "YOLO permission test completed";
      setNotice(detail);
    } catch (error) { setNotice(`YOLO permission test failed: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setTestingYolo(false); }
  };
  const saveLauncher = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); setSavingLauncher(true);
    try {
      const response = await fetch("http://127.0.0.1:7861/api/settings/session-launcher", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_launcher: launcher }) });
      const result: unknown = await response.json();
      if (!response.ok) throw new Error(typeof result === "object" && result !== null && typeof (result as { error?: unknown }).error === "string" ? (result as { error: string }).error : "settings save failed");
      setRestartRequired(true); setNotice("Session launcher saved. Restart Host 2.0 to apply it.");
    } catch (error) { setNotice(`Could not save session launcher: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setSavingLauncher(false); }
  };
  const saveCwd = async (event: FormEvent): Promise<void> => {
    event.preventDefault(); setSavingCwd(true);
    try {
      const response = await fetch("http://127.0.0.1:7861/api/settings/tool-cwd", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: cwdTool, cwd }) });
      const result: unknown = await response.json();
      if (!response.ok) throw new Error(typeof result === "object" && result !== null && typeof (result as { error?: unknown }).error === "string" ? (result as { error: string }).error : "settings save failed");
      setRestartRequired(true); setNotice("Working directory saved. Restart Host 2.0 to apply it.");
    } catch (error) { setNotice(`Could not save working directory: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setSavingCwd(false); }
  };
  const restartHost = async (): Promise<void> => {
    if (!window.vibestickDesktop) return;
    setRestarting(true);
    try { await window.vibestickDesktop.restartHost(); setRestartRequired(false); setNotice("Restarting Host 2.0…"); }
    catch (error) { setNotice(`Could not restart Host 2.0: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setRestarting(false); }
  };
  const releasePythonOwner = async (): Promise<void> => {
    if (!window.vibestickDesktop) return;
    setReleasingOwner(true);
    try {
      const result = await window.vibestickDesktop.releasePythonOwner();
      setNotice(result.detail);
    } catch (error) { setNotice(`Could not release Python 1.x BLE owner: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setReleasingOwner(false); }
  };
  const downloadDiagnostics = (): void => {
    const anchor = document.createElement("a");
    anchor.href = "http://127.0.0.1:7861/api/diagnostics";
    anchor.download = "vibestick-diagnostics.json";
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
  };
  const manageLoginStartup = async (action: "install" | "uninstall"): Promise<void> => {
    if (!window.vibestickDesktop) return;
    setLoginBusy(action);
    try {
      const result = await window.vibestickDesktop.loginStartup(action);
      setNotice(result.detail);
      if (result.ok) setLoginStartupEnabled(action === "install");
    }
    catch (error) { setNotice(`Could not update login startup: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setLoginBusy(undefined); }
  };
  const runtime = data.environment.runtime;
  const bleConnected = data.environment.owner === "active";
  const yolo = data.environment.capabilities.yolo;
  const yoloPermissionTestAvailable = yolo?.testable === true;
  const selected = data.sessions.list.find((session) => session.id === data.active_session) ?? data.sessions.list[0];

  return <main className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">V</span><span>VibeStick</span><small>HOST 2.0</small></div>
      <nav aria-label="Primary navigation">
        <a className="active" href="#overview">Overview</a><a href="#sessions">Sessions</a><a href="#voice">Voice &amp; modes</a><a href="#settings">Settings</a>
      </nav>
      <div className="sidebar-bottom"><span className={connected ? "dot green" : "dot"}></span>{connected ? "Local runtime reachable" : "Preview mode"}</div>
    </aside>
    <section className="workspace" id="overview">
      <header className="topbar">
        <div><p className="eyebrow">DEVICE CONTROL CENTER</p><h1>Good afternoon.</h1></div>
        <div className="connection"><span className={`dot ${bleConnected ? "green" : runtime === "degraded" ? "amber" : ""}`}></span><strong>{bleConnected ? "BLE connected" : runtime === "degraded" ? "Needs attention" : "Not connected"}</strong><span className="owner">Host 2.0 {bleConnected ? "active" : "standby"}</span></div>
      </header>
      {notice && <div className="notice"><span>{notice}</span>{restartRequired && window.vibestickDesktop && <button onClick={() => void restartHost()} disabled={restarting}>{restarting ? "Restarting…" : "Restart Host 2.0"}</button>}</div>}
      {data.environment.traditional_owner.state === "running" && data.environment.owner === "inactive" && window.vibestickDesktop && <div className="handoff"><div><b>Python 1.x owns BLE</b><p>{data.environment.traditional_owner.detail ?? "Release it explicitly before Host 2.0 connects."}</p><small>This stops Python 1.x gracefully and releases its BLE lock. It does not delete configuration or sessions.</small></div><button onClick={() => void releasePythonOwner()} disabled={releasingOwner}>{releasingOwner ? "Releasing…" : "Release to Host 2.0"}</button></div>}
      <section className="device-row">
        <div className="device-summary"><div className="stick-art"><i></i><i></i><b>V</b></div><div><p className="eyebrow">M5STICKC PLUS</p><h2>VibeStick</h2><p>{bleConnected ? "BLE bridge connected and synchronized. Check capability cards for platform setup." : "Choose Host 2.0 as the BLE owner to connect."}</p></div></div>
        <div className="capabilities">{(["ble", "keyboard", "mic", "asr"] as const).map((key) => <div className="cap" key={key}><span className={`cap-icon ${data.environment.capabilities[key].available ? "on" : ""}`}>{data.environment.capabilities[key].available ? "✓" : "–"}</span><div><b>{key === "ble" ? "BLE bridge" : key === "keyboard" ? "HID keys" : key === "mic" ? "Vibe Mic" : "Agent ASR"}</b><small>{data.environment.capabilities[key].available ? "Available" : data.environment.capabilities[key].reason}</small></div></div>)}{yolo && <div className="cap"><span className={`cap-icon ${yolo.available ? "on" : ""}`}>{yolo.available ? "✓" : "–"}</span><div><b>YOLO input</b><small>{yolo.available ? yolo.reason ?? "Available" : yolo.reason}</small></div></div>}</div>
      </section>
      <section className="modes" id="voice"><div className="section-heading"><div><p className="eyebrow">INPUT MODES</p><h2>How the Stick speaks</h2></div><span className="current-route">Current route: {data.audio_route === "mic" ? "Vibe Mic" : "Agent CLI ASR"}</span></div>
        <div className="mode-list"><Mode name="Agent CLI" detail="Transcribe, then deliver to the selected session." active={data.audio_route === "asr"} /><Mode name="Vibe Mic" detail="Raw audio to your system input device." active={data.audio_route === "mic"} /><Mode name="YOLO" detail={yolo?.available ? "Transcribe into the currently focused application." : yolo?.reason ?? "Transcribe into the currently focused application."} warning={Boolean(yolo && !yolo.available)} state={yolo?.available ? "Ready to try" : "Setup required"} /></div>
      </section>
      <div className="content-grid">
        <section className="sessions" id="sessions"><div className="section-heading"><div><p className="eyebrow">AGENT CLI</p><h2>Sessions</h2></div><button className="text-button" onClick={() => void send("session.next")}>Next session →</button></div>
          <div className="session-list">{data.sessions.list.length ? data.sessions.list.map((session) => <button className={`session ${session.id === data.active_session ? "selected" : ""}`} key={session.id} onClick={() => void send("session.select", session.id)}><span className={`dot ${session.state === "idle" ? "green" : session.state === "running" ? "red" : "amber"}`}></span><span className="session-copy"><b>{session.session || session.id}</b><small>{session.tool}{session.last ? ` · ${session.last}` : ""}</small></span><span className="session-state">{session.state === "idle" ? "Ready" : session.state}</span></button>) : <div className="empty">No agent session is available yet. Start one on the paired host, then refresh.</div>}</div>
        </section>
        <aside className="activity"><p className="eyebrow">LIVE ACTIVITY</p><h2>{selected?.session ?? "No session selected"}</h2><div className="activity-line"><span className="dot green"></span><span>{selected?.last || "Waiting for a session"}</span></div><hr/><p className="eyebrow">YOLO SAFETY</p><p className="warning-copy">YOLO types into the focused app. VibeStick cannot inspect or choose that target.</p><div className="key-hints"><kbd>A</kbd><span>Enter</span><kbd>B</kbd><span>Escape ×2</span></div></aside>
      </div>
      <section className="settings" id="settings"><div className="section-heading"><div><p className="eyebrow">HOST SETUP</p><h2>Settings</h2></div><div className="settings-actions"><button className="diagnostics-button" onClick={downloadDiagnostics} disabled={!connected}>Download diagnostics</button><span className={data.environment.config.online_asr_configured ? "settings-good" : "settings-warn"}>{data.environment.config.online_asr_configured ? "Online ASR configured" : "Action required"}</span></div></div>
        <div className="settings-grid"><div><b>Agent ASR</b><p>{data.environment.config.asr_engine === "online" ? (data.environment.config.online_asr_configured ? `Online · ${data.environment.config.asr_model}` : "Online provider needs its API key.") : `Local · ${data.environment.config.asr_engine} (${data.environment.config.asr_model})`}</p><small>{data.environment.config.asr_engine === "online" ? "Key is write-only: it is never read back into this application." : "VibeConn 2.0 keeps voice policy in TypeScript and uses the existing local model runtime adapter."}</small></div><div><b>Shared configuration</b><p className="path">{data.environment.config.path || "Start Host 2.0 to locate configuration."}</p><small>Both implementations read the same ASR model, device, language and tool configuration.</small></div></div>
        <form className="asr-form" onSubmit={(event) => void saveAsr(event)}><label>OpenAI-compatible API base<input value={apiBase} onChange={(event) => setApiBase(event.target.value)} inputMode="url" required /></label><label>Model<input value={model} onChange={(event) => setModel(event.target.value)} required /></label><label>API key <small>Leave empty to keep existing key.</small><input value={apiKey} onChange={(event) => setApiKey(event.target.value)} type="password" autoComplete="new-password" /></label><div className="asr-actions"><button type="button" className="text-button" onClick={() => void testAsr()} disabled={testingAsr || !connected || !data.environment.config.online_asr_configured}>{testingAsr ? "Testing…" : "Test provider"}</button><button type="submit" disabled={saving || !connected}>{saving ? "Saving…" : "Save and restart later"}</button></div></form>
        {yoloPermissionTestAvailable && <div className="yolo-test"><div><b>YOLO focused input</b><p>{yolo?.reason ?? "Checks whether the focused application can receive YOLO input."}</p><small>This explicit test checks only permission and a foreground target. It never types text or presses a key.</small></div><button onClick={() => void testYolo()} disabled={testingYolo || !connected}>{testingYolo ? "Testing…" : "Test permission"}</button></div>}
        <form className="launcher-form" onSubmit={(event) => void saveLauncher(event)}><label>New-session launcher<select value={launcher} onChange={(event) => setLauncher(event.target.value as "auto" | "tmux" | "zellij")}><option value="auto">Auto (tmux → zellij → managed tmux)</option><option value="tmux">tmux only</option><option value="zellij">zellij only</option></select></label><small>Controls where Stick <code>session.new</code> opens the selected Agent CLI. A forced zellij launch needs an existing zellij session.</small><button type="submit" disabled={savingLauncher || !connected}>{savingLauncher ? "Saving…" : "Save launcher"}</button></form>
        <form className="cwd-form" onSubmit={(event) => void saveCwd(event)}><label>Agent CLI<select value={cwdTool} onChange={(event) => { const id = event.target.value; const tool = data.environment.config.tools.find((item) => item.id === id); setCwdTool(id); setCwd(tool?.cwd ?? ""); }}>{data.environment.config.tools.map((tool) => <option key={tool.id} value={tool.id}>{tool.name}</option>)}</select></label><label>Working directory<input value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="Empty: inherit pane / home" /></label><small>Used only when Stick creates a new session. Existing tmux/zellij panes keep their directory if this is empty.</small><button type="submit" disabled={savingCwd || !connected || !cwdTool}>{savingCwd ? "Saving…" : "Save directory"}</button></form>
        {window.vibestickDesktop && <div className="login-startup"><div><b>Start at login <span className={loginStartupEnabled ? "settings-good" : "settings-warn"}>{loginStartupEnabled === undefined ? "Checking…" : loginStartupEnabled ? "Enabled" : "Not enabled"}</span></b><p>Registers this desktop app for your user only. It never stops Python 1.x or takes the Stick automatically.</p></div><div><button onClick={() => void manageLoginStartup("install")} disabled={loginBusy !== undefined || loginStartupEnabled === true}>{loginBusy === "install" ? "Enabling…" : "Enable"}</button><button className="text-button" onClick={() => void manageLoginStartup("uninstall")} disabled={loginBusy !== undefined || loginStartupEnabled === false}>{loginBusy === "uninstall" ? "Removing…" : "Remove"}</button></div></div>}
      </section>
    </section>
  </main>;
}

function Mode({ name, detail, active, warning = false, state }: { name: string; detail: string; active?: boolean; warning?: boolean; state?: string }): ReactElement {
  return <div className={`mode ${active ? "mode-active" : ""}`}><span className="mode-index">{name === "Agent CLI" ? "01" : name === "Vibe Mic" ? "02" : "03"}</span><div><b>{name}</b><small>{detail}</small></div>{active ? <span className="mode-state">Active</span> : <span className={`mode-state ${warning ? "amber-label" : ""}`}>{state ?? "On Stick"}</span>}</div>;
}
