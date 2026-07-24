/* VibeStick dashboard SPA (vanilla JS, no deps, no build step) */
"use strict";

const $ = (id) => document.getElementById(id);
const state = {
  config: null,
  status: null,
  dirtyCount: 0,
  agentSel: null,       // selected agent id (agents master-detail)
  expandedSessions: new Set(),  // session accordion (agents)
  expandedTools: new Set(),     // tool cards (settings)
};

/* ---------- helpers ---------- */

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function toast(msg, isErr) {
  const t = $("toast");
  t.textContent = msg;
  t.className = isErr ? "err" : "";
  t.style.opacity = 1;
  setTimeout(() => { t.style.opacity = 0; }, 3000);
}
function fmtTime(epoch) {
  if (!epoch) return "—";
  return new Date(epoch * 1000).toLocaleTimeString();
}
function fmtRel(epoch) {
  if (!epoch) return "";
  const d = Math.max(0, Date.now() / 1000 - epoch);
  if (d < 45) return "just now";
  if (d < 90) return "1m ago";
  if (d < 3600) return Math.round(d / 60) + "m ago";
  if (d < 5400) return "1h ago";
  if (d < 86400) return Math.round(d / 3600) + "h ago";
  return Math.round(d / 86400) + "d ago";
}
function stateBadge(s) {
  return `<span class="badge state-${esc(s || "idle")}">${esc(s || "idle")}</span>`;
}
function liveBadge(s) {
  if (s === "running") return '<span class="badge state-running pulse">thinking</span>';
  return stateBadge(s);
}
function tailHtml(tail) {
  if (!tail || !tail.length) return "";
  const lines = tail.map((line) => {
    const cls = line.startsWith("user:") ? "t-user" : "t-assistant";
    return `<div class="${cls}">${esc(line)}</div>`;
  }).join("");
  return `<div class="s-tail">${lines}</div>`;
}
async function api(path, opts) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch (e) { /* ignore */ }
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}
function postCommand(cmd) {
  return api("/api/command", { method: "POST", body: JSON.stringify(cmd) });
}

/* ---------- routing (with view state in the hash) ---------- */
const PAGES = ["overview", "agents", "voice", "settings"];

function parseHash() {
  const raw = (location.hash || "#/overview").replace(/^#\//, "");
  const [pagePart, query] = raw.split("?");
  const seg = pagePart.split("/");
  return {
    page: PAGES.includes(seg[0]) ? seg[0] : "overview",
    id: seg[1] ? decodeURIComponent(seg[1]) : null,
    q: new URLSearchParams(query || ""),
  };
}
function writeHash() {
  let h = "#/" + route.page;
  if (route.page === "agents" && state.agentSel) h += "/" + encodeURIComponent(state.agentSel);
  if (route.page === "settings" && state.expandedTools.size) {
    h += "?t=" + [...state.expandedTools].map(encodeURIComponent).join(",");
  }
  history.replaceState(null, "", h);
}
let route = parseHash();

function applyRoute() {
  route = parseHash();
  PAGES.forEach((p) => $("page-" + p).classList.toggle("active", p === route.page));
  document.querySelectorAll("#sidebar nav a").forEach((a) =>
    a.classList.toggle("active", a.dataset.page === route.page));
  if (route.page === "agents" && route.id) state.agentSel = route.id;
  if (route.page === "settings" && route.q.get("t")) {
    state.expandedTools = new Set(route.q.get("t").split(",").map(decodeURIComponent));
  }
  renderAll();
}
window.addEventListener("hashchange", applyRoute);

/* ---------- data ---------- */
async function loadConfig() {
  state.config = await api("/api/config");
  state.dirtyCount = 0;
  updateSavebar();
  renderConfigForms();
}
async function pollStatus() {
  try {
    state.status = await api("/api/status");
  } catch (e) { return; }
  renderStatus();
}
function renderAll() {
  if (state.status) renderStatus();
  if (state.config) renderConfigForms();
}

/* ---------- status rendering ---------- */
function renderStatus() {
  const st = state.status;
  if (!st) return;
  const on = !!st.connected;
  $("side-dot").className = "dot" + (on ? " on" : "");
  $("side-conn").textContent = on ? "connected" : "scanning…";

  $("conn-dot").className = "dot big breath" + (on ? " on" : "");
  $("conn-title").textContent = on ? "Stick connected" : "Not connected";
  $("conn-title").style.color = on ? "var(--green)" : "var(--dim)";
  $("conn-sub").textContent = on ? (st.device_address || "VibeStick") : "scanning for VibeStick…";
  $("conn-meta").innerHTML = [
    ["connected since", fmtTime(st.connected_since)],
    ["last sync", fmtTime(st.last_sync)],
    ["uptime", (st.uptime_sec ?? 0) + "s"],
    ["selected tool", st.selected_tool || "—"],
    ["config", st.config_path || "—"],
  ].map(([k, v]) => `<span>${k}: <b>${esc(v)}</b></span>`).join("");

  const tools = st.tools || [];
  const allSessions = tools.flatMap((t) => t.sessions || []);
  const running = allSessions.filter((s) => s.state === "running").length;
  const fg = allSessions.filter((s) => s.fg).length;
  $("st-agents").textContent = tools.length;
  $("st-agents-sub").textContent =
    `${tools.filter((t) => t.adapter).length} with adapter · ${tools.filter((t) => t.delivery).length} deliverable`;
  $("st-sessions").textContent = allSessions.length;
  $("st-sessions-sub").textContent = `${running} running · ${fg} foreground`;
  const asr = st.asr || {};
  $("st-voice").textContent = asr.engine || "—";
  $("st-voice-sub").textContent = asr.installed
    ? `${asr.engine === "command" ? "external" : "v" + (asr.version || "?")} · ${asr.model || ""} · ${asr.device || ""}`
    : (asr.note || "not installed");
  const mic = st.mic || {};
  $("st-mic").textContent = mic.enabled ? (mic.active ? "feeding" : "ready") : "disabled";
  $("st-mic-sub").textContent = mic.enabled ? '"VibeStick Mic" source' : "mic.enabled=false";

  const acts = [];
  tools.forEach((t) => (t.sessions || []).forEach((s) => acts.push({ tool: t.name, ...s })));
  acts.sort((a, b) => (b.updated || 0) - (a.updated || 0));
  $("activity").innerHTML = acts.length
    ? acts.slice(0, 8).map((s) => `<div class="act-row">${liveBadge(s.state)}` +
        `<b>${esc(s.tool)}</b><span class="dim">${esc(s.name)}</span>` +
        `<span class="t">${esc(fmtRel(s.updated))}</span>` +
        (s.tail && s.tail.length ? `<span class="a-tail">${esc(s.tail[s.tail.length - 1])}</span>` : "") +
        `</div>`).join("")
    : '<p class="dim">no sessions yet</p>';

  renderAgents();
  renderMic();
  renderAsrStatus();
}

/* ---------- agents: master-detail ---------- */
let _agentsFingerprint = "";

function _cfgTool(id) {
  return (state.config?.tools || []).find((t) => t.id === id) || {};
}

function renderAgents() {
  const st = state.status;
  if (!st) return;
  const focused = document.activeElement;
  if (focused && focused.dataset && focused.dataset.launch) return; // don't yank focus
  const fp = JSON.stringify([st.tools, state.agentSel, [...state.expandedSessions],
    (state.config?.tools || []).map((t) => t.command)]);
  if (fp === _agentsFingerprint) return;
  _agentsFingerprint = fp;

  const tools = st.tools || [];
  const running = tools.reduce((n, t) => n + (t.sessions || []).filter((s) => s.state === "running").length, 0);
  $("agents-count").textContent = `${tools.length} agents · ${running} running`;

  if (!state.agentSel || !tools.some((t) => t.id === state.agentSel)) {
    state.agentSel = tools[0]?.id ?? null;
  }

  const rail = $("agents-rail");
  rail.innerHTML = "";
  if (!tools.length) {
    rail.innerHTML = '<div class="empty"><div class="empty-icon">◌</div>' +
      '<p>No agents configured yet.</p><p class="dim">Add one under Settings → Tools.</p></div>';
  }
  tools.forEach((t) => {
    const fg = (t.sessions || []).some((s) => s.fg);
    const live = (t.sessions || []).some((s) => s.state === "running");
    const row = document.createElement("button");
    row.className = "agent-row" + (t.id === state.agentSel ? " selected" : "");
    row.innerHTML = `<span class="fg-dot${fg ? " on" : ""}"></span>` +
      `<span class="s-name">${esc(t.name)}</span>` +
      (live ? '<span class="badge state-running pulse mini">thinking</span>' : "");
    row.onclick = () => { state.agentSel = t.id; writeHash(); renderAgents(); };
    rail.appendChild(row);
  });

  renderAgentDetail(tools.find((t) => t.id === state.agentSel));
}

function renderAgentDetail(agent) {
  const host = $("agent-detail");
  if (!agent) {
    host.innerHTML = '<div class="empty"><div class="empty-icon">⇠</div>' +
      '<p>Select an agent</p><p class="dim">Pick one from the list to inspect its sessions.</p></div>';
    return;
  }
  const cfgTool = _cfgTool(agent.id);
  const sessions = agent.sessions || [];
  host.innerHTML = "";

  const card = document.createElement("div");
  card.className = "card agent-hero";
  card.innerHTML =
    `<div class="hero-icon">${esc((agent.name || "?")[0].toUpperCase())}</div>` +
    `<div class="hero-body"><div class="agent-head"><h3>${esc(agent.name)}</h3>` +
    (agent.selected ? '<span class="badge sel">selected on stick</span>' : "") +
    (agent.adapter ? '<span class="badge ok">adapter online</span>' : '<span class="badge">no adapter</span>') +
    (agent.delivery ? `<span class="badge ok">${esc(agent.delivery)}</span>` : '<span class="badge warn">no delivery</span>') +
    `</div>` +
    `<label>launch command (session.new)</label>` +
    `<input data-launch="${esc(agent.id)}" value="${esc(cfgTool.command || "")}" placeholder="${esc(cfgTool.process || "cli command")}"></div>`;
  host.appendChild(card);

  const sessCard = document.createElement("div");
  sessCard.className = "card";
  sessCard.innerHTML = `<div class="card-head"><h2>Sessions</h2><span class="dim">${sessions.length}</span></div>`;
  if (!sessions.length) {
    sessCard.innerHTML += '<div class="empty"><div class="empty-icon">▤</div>' +
      `<p>No sessions yet.</p><p class="dim">Start ${esc(agent.name)} in a terminal — it shows up here automatically.</p></div>`;
  } else {
    const list = document.createElement("div");
    list.className = "session-table";
    sessions.forEach((s) => list.appendChild(sessionRow(agent, s)));
    sessCard.appendChild(list);
  }
  host.appendChild(sessCard);

  host.querySelector("input[data-launch]").onchange = (e) => {
    const tool = (state.config?.tools || []).find((t) => t.id === agent.id);
    if (!tool) return;
    tool.command = e.target.value.trim();
    saveConfig(true);
    e.target.classList.add("saved-flash");
    setTimeout(() => e.target.classList.remove("saved-flash"), 900);
  };
}

function sessionRow(agent, s) {
  const row = document.createElement("div");
  const open = state.expandedSessions.has(s.id);
  row.className = "session-row" + (open ? " open" : "");
  const preview = (s.tail && s.tail.length) ? s.tail[s.tail.length - 1] : "";
  row.innerHTML =
    `<div class="s-row" data-toggle>
      <span class="fg-dot${s.fg ? " on" : ""}"></span>
      <span class="s-name">${esc(s.name)}</span>
      <span class="s-time">${esc(fmtRel(s.updated))}</span>
      ${liveBadge(s.state)}
      ${s.pending ? `<span class="badge warn">queued ${s.pending}</span>` : ""}
      <span class="s-caret">${open ? "▾" : "▸"}</span>
    </div>` +
    (preview && !open ? `<div class="s-preview mono">${esc(preview)}</div>` : "") +
    (open ? tailHtml(s.tail) +
      `<div class="s-actions">
        <button class="small" data-act="select">在 stick 上选中</button>
        <button class="small" data-act="new">新开会话</button>
      </div>` : "");
  row.querySelector("[data-toggle]").onclick = () => {
    if (state.expandedSessions.has(s.id)) state.expandedSessions.delete(s.id);
    else state.expandedSessions.add(s.id);
    renderAgents();
  };
  const selBtn = row.querySelector('[data-act="select"]');
  if (selBtn) selBtn.onclick = async (e) => {
    e.stopPropagation();
    try {
      await postCommand({ cmd: "tool.select", id: agent.id });
      await postCommand({ cmd: "session.select", id: s.id });
      toast(`Selected ${s.name} on the stick`);
    } catch (err) { toast("select failed: " + err.message, true); }
  };
  const newBtn = row.querySelector('[data-act="new"]');
  if (newBtn) newBtn.onclick = async (e) => {
    e.stopPropagation();
    try {
      await postCommand({ cmd: "tool.select", id: agent.id });
      await postCommand({ cmd: "session.new" });
      toast(`New ${agent.name} session requested`);
    } catch (err) { toast("session.new failed: " + err.message, true); }
  };
  return row;
}

/* ---------- voice & mic (status only) ---------- */
function renderMic() {
  const mic = state.status?.mic || {};
  $("mic-badge").innerHTML = mic.enabled
    ? '<span class="badge ok">enabled</span>' : '<span class="badge err">disabled</span>';
  $("mic-meta").innerHTML = [
    ["state", mic.active ? "feeding (PTT active)" : "idle"],
    ["source", "VibeStick Mic"],
    ["format", "8 kHz · 8-bit · mono"],
  ].map(([k, v]) => `<span>${k}: <b>${esc(v)}</b></span>`).join("");
}

function renderAsrStatus() {
  const asr = state.status?.asr;
  if (!asr) return;
  $("asr-badge").innerHTML = asr.installed
    ? `<span class="badge ok">${asr.engine === "command" ? "external" : "v" + esc(asr.version || "?")}</span>`
    : '<span class="badge err">not installed</span>';
  $("asr-meta").innerHTML = [
    ["engine", asr.engine || "—"],
    ["model", asr.model || "—"],
    ["device", asr.device || "—"],
    ["peak normalization", asr.peak_normalization ? "enabled" : "off"],
    ["CUDA devices", asr.cuda_devices == null ? "n/a" : String(asr.cuda_devices)],
  ].map(([k, v]) => `<span>${k}: <b>${esc(v)}</b></span>`).join("");
  $("asr-note").textContent = asr.note ||
    (asr.installed ? "" : "install with: pip install 'vibestick[asr]'");

  const recent = asr.recent || [];
  const badgeFor = (s) => s === "ok" ? '<span class="badge ok">ok</span>'
    : s === "no-speech" ? '<span class="badge warn">no speech</span>'
    : '<span class="badge err">error</span>';
  $("asr-recent").innerHTML = recent.length
    ? recent.map((r) => `<div class="act-row">${badgeFor(r.state)}` +
        `<span class="t">${esc(fmtTime(r.ts))}</span>` +
        `<span class="dim">${esc((r.duration_sec ?? "?") + "s")}</span>` +
        `<span class="a-tail">${esc(r.text || r.reason || "")}</span></div>`).join("")
    : '<p class="dim">no transcription attempts yet</p>';
}

/* ---------- settings ---------- */

function renderConfigForms() {
  const cfg = state.config;
  if (!cfg) return;
  $("mic-enabled").checked = cfg.mic?.enabled !== false;
  $("feat-procwatcher").checked = cfg.features?.process_watcher !== false;
  $("feat-voice").checked = cfg.features?.voice_enabled !== false;
  $("asr-engine").value = cfg.asr?.engine || "faster-whisper";
  $("asr-language").value = cfg.asr?.language || "";
  $("asr-command").value = cfg.asr?.command || "";
  renderSegmented($("asr-model"), ["tiny", "base", "small"], cfg.asr?.model || "base",
    (v) => { cfg.asr = { ...cfg.asr, model: v }; markDirty(); });
  renderAsrDevice(cfg);
  asrVisibility();

  const host = $("tools");
  host.innerHTML = "";
  (cfg.tools || []).forEach((tool, i) => host.appendChild(toolCard(tool, i)));

  const st = state.status || {};
  $("adv-meta").innerHTML = [
    ["config", st.config_path || "—"],
    ["dashboard", location.host],
    ["selected tool", st.selected_tool || "—"],
  ].map(([k, v]) => `<span>${k}: <b>${esc(v)}</b></span>`).join("");
}

function renderAsrDevice(cfg) {
  const cudaN = state.status?.asr?.cuda_devices ?? 0;
  const cur = cfg.asr?.device || "cpu";
  const opts = [
    { value: "cpu", label: "cpu" },
    { value: "cuda", label: cudaN > 0 ? `cuda (${cudaN})` : "cuda",
      disabled: cudaN === 0, title: cudaN === 0 ? "unavailable: no CUDA devices" : "" },
  ];
  renderSegmented($("asr-device"), opts, cur,
    (v) => { cfg.asr = { ...cfg.asr, device: v }; markDirty(); });
}

function renderSegmented(host, options, current, onPick) {
  host.innerHTML = "";
  options.forEach((opt) => {
    const o = typeof opt === "string" ? { value: opt, label: opt } : opt;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "seg-btn" + (o.value === current ? " active" : "");
    b.textContent = o.label;
    if (o.disabled) { b.disabled = true; }
    if (o.title) { b.title = o.title; }
    if (!o.disabled) b.onclick = () => { onPick(o.value); renderConfigForms(); };
    host.appendChild(b);
  });
}

function toolCard(tool, i) {
  const id = tool.id || `new-${i}`;
  const open = state.expandedTools.has(id);
  const div = document.createElement("div");
  div.className = "card tool-card" + (open ? " open" : "");
  const head = document.createElement("div");
  head.className = "tool-head";
  head.innerHTML = `<span class="s-caret">${open ? "▾" : "▸"}</span>
    <h3>${esc(tool.name || tool.id || "(unnamed)")}</h3>
    <span class="badge">${esc(tool.adapter || "wrapper")}</span>
    <span class="badge ${tool.hidden ? "" : "ok"}">${tool.hidden ? "hidden" : "on device"}</span>`;
  head.onclick = () => {
    if (state.expandedTools.has(id)) state.expandedTools.delete(id);
    else state.expandedTools.add(id);
    writeHash();
    renderConfigForms();
  };
  div.appendChild(head);
  if (open) {
    const body = document.createElement("div");
    body.className = "tool-body";
    body.dataset.index = String(i);
    body.innerHTML = `
      <div class="grid2">
        <div><label>ID</label><input data-f="id" value="${esc(tool.id || "")}"></div>
        <div><label>Display name</label><input data-f="name" value="${esc(tool.name || "")}"></div>
        <div><label>Adapter</label>
          <select data-f="adapter">
            <option value="statusline">statusline</option>
            <option value="wrapper">wrapper</option>
          </select></div>
        <div><label>Delivery</label>
          <select data-f="delivery">
            <option value="auto">auto</option>
            <option value="tmux">tmux</option>
            <option value="tty">tty</option>
          </select></div>
        <div><label>Process name</label><input data-f="process" value="${esc(tool.process || "")}"></div>
        <div><label>Launch command</label><input data-f="command" value="${esc(tool.command || "")}"></div>
      </div>
      <div class="toggle-row"><span>Show on device</span>
        <label class="toggle"><input type="checkbox" data-f-hidden ${tool.hidden ? "" : "checked"}><span class="slider"></span></label></div>
      <div class="toggle-row"><span>Discover sessions from disk</span>
        <label class="toggle"><input type="checkbox" data-f-discover ${tool.discover === false ? "" : "checked"}><span class="slider"></span></label></div>
      <label>Key bindings</label>
      <table class="bindings"><tbody></tbody></table>
      <div class="row">
        <input placeholder="binding id" data-new-id>
        <input placeholder="key sequence" data-new-key>
        <button class="small" data-act="add-binding">Add</button>
        <button class="small" data-preset="ctrl-c|C-c">ctrl-c</button>
        <button class="small" data-preset="escape|Escape">escape</button>
        <button class="small" data-preset="enter|Enter">enter</button>
      </div>
      <div class="row" style="justify-content:flex-end">
        <button class="danger small" data-act="remove">Delete tool</button>
      </div>`;
    body.querySelector('[data-f="adapter"]').value = tool.adapter || "wrapper";
    body.querySelector('[data-f="delivery"]').value = tool.delivery || "auto";
    const tbody = body.querySelector("tbody");
    Object.entries(tool.bindings || {}).forEach(([bid, key]) => tbody.appendChild(bindingRow(bid, key)));
    body.querySelectorAll("input[data-f], select[data-f]").forEach((el) => {
      el.oninput = () => { tool[el.dataset.f] = el.value; markDirty(); };
    });
    body.querySelector("[data-f-hidden]").onchange = (e) => { tool.hidden = !e.target.checked; markDirty(); };
    body.querySelector("[data-f-discover]").onchange = (e) => { tool.discover = e.target.checked; markDirty(); };
    body.querySelector('[data-act="add-binding"]').onclick = () => {
      const bid = body.querySelector("[data-new-id]").value.trim();
      const key = body.querySelector("[data-new-key]").value.trim();
      if (!bid || !key) { toast("binding id and key sequence required", true); return; }
      tool.bindings = tool.bindings || {};
      tool.bindings[bid] = key;
      markDirty();
      renderConfigForms();
    };
    body.querySelectorAll("[data-preset]").forEach((b) => {
      b.onclick = () => {
        const [bid, key] = b.dataset.preset.split("|");
        tool.bindings = tool.bindings || {};
        tool.bindings[bid] = key;
        markDirty();
        renderConfigForms();
      };
    });
    body.querySelector('[data-act="remove"]').onclick = () => {
      if (!confirm(`Delete tool "${tool.name || tool.id}"?`)) return;
      state.config.tools.splice(i, 1);
      state.expandedTools.delete(id);
      writeHash();
      markDirty();
      renderConfigForms();
    };
    div.appendChild(body);
  }
  return div;
}

function bindingRow(id, key) {
  const tr = document.createElement("tr");
  tr.innerHTML = `<td><input value="${esc(id)}" data-bid></td>
                  <td><input value="${esc(key)}" data-bkey></td>
                  <td><button class="danger small">x</button></td>`;
  tr.querySelectorAll("input").forEach((el) => { el.oninput = markDirty; });
  tr.querySelector("button").onclick = () => { tr.remove(); markDirty(); };
  return tr;
}

function asrVisibility() {
  const fw = $("asr-engine").value === "faster-whisper";
  $("asr-fw").hidden = !fw;
  $("asr-cmd").hidden = fw;
}

/* ---------- save flow ---------- */

function markDirty() {
  state.dirtyCount += 1;
  updateSavebar();
}
function updateSavebar() {
  $("save-note").textContent = state.dirtyCount
    ? `${state.dirtyCount} unsaved change${state.dirtyCount > 1 ? "s" : ""}` : "";
  $("save").disabled = state.dirtyCount === 0;
}

function collect() {
  const cfg = state.config;
  // Tools are live-mutated via data-f inputs; only the bindings rows of
  // expanded cards need syncing back from the DOM.
  document.querySelectorAll("#tools .tool-card .tool-body").forEach((body) => {
    const tool = cfg.tools[Number(body.dataset.index)];
    if (!tool) return;
    const bindings = {};
    body.querySelectorAll(".bindings tbody tr").forEach((tr) => {
      const bid = tr.querySelector("[data-bid]").value.trim();
      const key = tr.querySelector("[data-bkey]").value.trim();
      if (bid && key) bindings[bid] = key;
    });
    tool.bindings = bindings;
  });
  cfg.asr = {
    engine: $("asr-engine").value,
    model: cfg.asr?.model || "base",
    device: cfg.asr?.device || "cpu",
    language: $("asr-language").value.trim() || null,
    command: $("asr-command").value.trim(),
  };
  cfg.features = {
    process_watcher: $("feat-procwatcher").checked,
    voice_enabled: $("feat-voice").checked,
  };
  cfg.mic = { enabled: $("mic-enabled").checked };
  return cfg;
}

async function saveConfig(quiet) {
  if (!state.config) return;
  const body = JSON.stringify(collect(), null, 2);
  try {
    await api("/api/config", { method: "POST", body });
    state.dirtyCount = 0;
    updateSavebar();
    if (!quiet) toast("Saved — the daemon picks up changes automatically.");
  } catch (err) {
    toast("Save failed: " + err.message, true);
  }
}

/* ---------- wiring ---------- */
$("add-tool").onclick = () => {
  collect();
  const tool = { id: "", name: "", adapter: "wrapper", delivery: "auto",
    bindings: {}, process: "", command: "", hidden: false, discover: true };
  state.config.tools.push(tool);
  state.expandedTools.add(`new-${state.config.tools.length - 1}`);
  writeHash();
  markDirty();
  renderConfigForms();
};
$("save").onclick = () => saveConfig(false);
$("reload").onclick = loadConfig;
$("asr-engine").onchange = () => {
  state.config.asr = { ...state.config.asr, engine: $("asr-engine").value };
  asrVisibility(); markDirty();
};
$("mic-enabled").onchange = markDirty;
["asr-language", "asr-command", "feat-procwatcher", "feat-voice"].forEach((id) => {
  $(id).onchange = markDirty;
  $(id).oninput = markDirty;
});

applyRoute();
loadConfig();
pollStatus();
setInterval(pollStatus, 3000);
