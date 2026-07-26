import { useEffect, useState, type ReactElement } from "react";

declare global { interface Window { vibestickDesktop?: { hostStatus(): Promise<{ state: string; detail?: string }> }; } }

type Capability = { available: boolean; reason?: string };
type Session = { id: string; state: "idle" | "running" | "waiting"; session: string; model: string; last: string; tool: string };
type Snapshot = {
  selected_tool: string | null; active_session: string | null; audio_route: "asr" | "mic"; queued: number;
  status: { state: string; session: string; tool: string; model: string };
  sessions: { list: Session[] };
  tools: { list: { id: string; name: string; state: string }[] };
  environment: { owner: "active" | "inactive"; runtime: string; capabilities: { ble: Capability; keyboard: Capability; mic: Capability; asr: Capability }; error?: string };
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
    ble: { available: false, reason: "Start the Host 2.0 runtime" }, keyboard: { available: false, reason: "Start the Host 2.0 runtime" }, mic: { available: false, reason: "Start the Host 2.0 runtime" }, asr: { available: false, reason: "Configure online ASR" },
  } },
};

export function App(): ReactElement {
  const [data, setData] = useState<Snapshot>(demo);
  const [connected, setConnected] = useState(false);
  const [notice, setNotice] = useState("Host 2.0 is not running — showing a local preview.");

  useEffect(() => {
    let active = true;
    const refresh = async (): Promise<void> => {
      try { const snapshot = await api("/api/desktop"); if (active) { setData(snapshot); setConnected(true); setNotice(""); } }
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

  const send = async (cmd: string, id?: string): Promise<void> => {
    try {
      const snapshot = await api("/api/command", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cmd, ...(id ? { id } : {}) }) });
      setData(snapshot); setNotice("");
    } catch { setNotice("That control needs a running Host 2.0 runtime."); }
  };
  const runtime = data.environment.runtime;
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
        <div className="connection"><span className={`dot ${runtime === "ready" ? "green" : runtime === "degraded" ? "amber" : ""}`}></span><strong>{runtime === "ready" ? "Connected" : runtime === "degraded" ? "Needs attention" : "Not connected"}</strong><span className="owner">Host 2.0 {data.environment.owner === "active" ? "active" : "standby"}</span></div>
      </header>
      {notice && <div className="notice">{notice}</div>}
      <section className="device-row">
        <div className="device-summary"><div className="stick-art"><i></i><i></i><b>V</b></div><div><p className="eyebrow">M5STICKC PLUS</p><h2>VibeStick</h2><p>{runtime === "ready" ? "BLE bridge connected and synchronized." : "Choose Host 2.0 as the BLE owner to connect."}</p></div></div>
        <div className="capabilities">{(["ble", "keyboard", "mic", "asr"] as const).map((key) => <div className="cap" key={key}><span className={`cap-icon ${data.environment.capabilities[key].available ? "on" : ""}`}>{data.environment.capabilities[key].available ? "✓" : "–"}</span><div><b>{key === "ble" ? "BLE bridge" : key === "keyboard" ? "HID keys" : key === "mic" ? "Vibe Mic" : "Agent ASR"}</b><small>{data.environment.capabilities[key].available ? "Available" : data.environment.capabilities[key].reason}</small></div></div>)}</div>
      </section>
      <section className="modes" id="voice"><div className="section-heading"><div><p className="eyebrow">INPUT MODES</p><h2>How the Stick speaks</h2></div><span className="current-route">Current route: {data.audio_route === "mic" ? "Vibe Mic" : "Agent CLI ASR"}</span></div>
        <div className="mode-list"><Mode name="Agent CLI" detail="Transcribe, then deliver to the selected session." active={data.audio_route === "asr"} /><Mode name="Vibe Mic" detail="Raw audio to your system input device." active={data.audio_route === "mic"} /><Mode name="YOLO" detail="Transcribe into the currently focused application." warning /></div>
      </section>
      <div className="content-grid">
        <section className="sessions" id="sessions"><div className="section-heading"><div><p className="eyebrow">AGENT CLI</p><h2>Sessions</h2></div><button className="text-button" onClick={() => void send("session.next")}>Next session →</button></div>
          <div className="session-list">{data.sessions.list.length ? data.sessions.list.map((session) => <button className={`session ${session.id === data.active_session ? "selected" : ""}`} key={session.id} onClick={() => void send("session.select", session.id)}><span className={`dot ${session.state === "idle" ? "green" : session.state === "running" ? "red" : "amber"}`}></span><span className="session-copy"><b>{session.session || session.id}</b><small>{session.tool}{session.last ? ` · ${session.last}` : ""}</small></span><span className="session-state">{session.state === "idle" ? "Ready" : session.state}</span></button>) : <div className="empty">No agent session is available yet. Start one on the paired host, then refresh.</div>}</div>
        </section>
        <aside className="activity"><p className="eyebrow">LIVE ACTIVITY</p><h2>{selected?.session ?? "No session selected"}</h2><div className="activity-line"><span className="dot green"></span><span>{selected?.last || "Waiting for a session"}</span></div><hr/><p className="eyebrow">YOLO SAFETY</p><p className="warning-copy">YOLO types into the focused app. VibeStick cannot inspect or choose that target.</p><div className="key-hints"><kbd>A</kbd><span>Enter</span><kbd>B</kbd><span>Escape ×2</span></div></aside>
      </div>
    </section>
  </main>;
}

function Mode({ name, detail, active, warning = false }: { name: string; detail: string; active?: boolean; warning?: boolean }): ReactElement {
  return <div className={`mode ${active ? "mode-active" : ""}`}><span className="mode-index">{name === "Agent CLI" ? "01" : name === "Vibe Mic" ? "02" : "03"}</span><div><b>{name}</b><small>{detail}</small></div>{active ? <span className="mode-state">Active</span> : warning ? <span className="mode-state amber-label">Focused target</span> : <span className="mode-state">On Stick</span>}</div>;
}
