"""Session store: watches ~/.vibestick/sessions/*.json (polling, no watchdog),
tracks the selected tool and its active session, applies device commands,
prunes stale sessions.

With a Config attached (v2), SESSIONS shows only the selected tool's
sessions and TOOLS aggregates per-tool state. Without a config (v1
behavior) all sessions are shown and tool commands are unavailable.
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass
from pathlib import Path

from . import protocol
from .config import Config

log = logging.getLogger(__name__)

DEFAULT_DIR = Path.home() / ".vibestick" / "sessions"
STALE_AFTER_SEC = 30 * 60  # prune sessions with no update for >30min
POLL_INTERVAL_SEC = 1.0

# Aggregate tool state precedence: running > waiting > error > idle.
_STATE_PRIORITY = ("running", "waiting", "error", "idle")

# Synthesized session ids for presence-only tools (no adapter files).
PRESENCE_ID_PREFIX = "proc:"

# Discovered session ids (from CLI on-disk stores) and their "running" window.
# Ids are compact ("disc:" + 6 hex of sha1(tool:stable-id)) so they fit the
# firmware's 12-char session id buffer (11 usable chars) — longer ids get
# truncated on-device and bounce back in session.select.
DISCOVERED_ID_PREFIX = "disc:"
DISCOVERED_RECENT_SEC = 20  # mtime within this + live process => running
# "running" means *inferring*: transcripts stream during generation, so a
# short window is a good proxy. A longer window (e.g. 3min) keeps a session
# stuck at "running" long after inference ended — the device then shows a
# permanent "thinking" footer. fg (session merely open) uses the wider
# FG_RECENT_SEC window below.

FG_RECENT_SEC = 3 * 60  # heuristic fg window (mtime within this + live process)
NEW_SESSION_TIMEOUT_SEC = 30.0  # how long session.new waits for the new session


@dataclass
class SessionRecord:
    """A session file's parsed content plus filesystem metadata."""

    id: str
    status: protocol.SessionStatus
    raw: dict  # full file content (may carry delivery fields: tmux / tty)
    mtime: float


class SessionStore:
    def __init__(
        self,
        directory: Path | str = DEFAULT_DIR,
        config: Config | None = None,
        watcher=None,
        discovery=None,
    ) -> None:
        self.dir = Path(directory)
        self._records: dict[str, SessionRecord] = {}
        self._files: dict[str, str] = {}  # path name -> session id
        self._mtimes: dict[str, float] = {}  # path name -> mtime for change detection
        self.active_id: str | None = None
        self.config = config
        self._watcher = watcher  # procwatch.ProcessWatcher or compatible stub
        self._discovery = discovery  # discover.SessionDiscovery or compatible stub
        self._discovered: dict[str, SessionRecord] = {}  # "disc:<tool>:<id>" -> record
        self._presence: dict[str, object] = {}  # tool id -> procwatch.ProcInfo
        self._presence_since: dict[str, float] = {}  # tool id -> first-seen epoch
        self._pending_new: tuple[str, frozenset, float] | None = None  # session.new
        self.selected_tool: str | None = None
        if config is not None:
            visible = self._visible_tools()
            if visible:
                self.selected_tool = visible[0].id

    # -- config / tool selection --------------------------------------------

    def _visible_tools(self):
        """Configured tools shown on the device (hidden ones excluded)."""
        if self.config is None:
            return []
        return [t for t in self.config.tools if not t.hidden]

    def set_config(self, config: Config) -> bool:
        """Swap in a (reloaded) config. Returns True if selection changed."""
        self.config = config
        old = (self.selected_tool, self.active_id)
        ids = [t.id for t in self._visible_tools()]
        if self.selected_tool not in ids:
            self.selected_tool = ids[0] if ids else None
        self._ensure_active()
        return (self.selected_tool, self.active_id) != old

    def selected_tool_config(self):
        if self.config is None:
            return None
        return self.config.tool_by_id(self.selected_tool)

    # -- process presence ------------------------------------------------------

    def refresh_presence(self) -> bool:
        """Scan for tool processes; returns True if presence changed.

        Presence only matters for tools with no adapter session files
        (adapter data always wins). Gated by the process_watcher feature.
        """
        if (
            self._watcher is None
            or self.config is None
            or not self.config.features.process_watcher
        ):
            return self._set_presence({})
        names = {}
        for t in self.config.tools:
            for proc_name in t.process_names():
                names.setdefault(proc_name, t.id)
        try:
            found = self._watcher.scan(set(names))
        except Exception as exc:  # noqa: BLE001 - presence is best-effort
            log.warning("process scan failed: %s", exc)
            return False
        presence: dict[str, object] = {}
        for proc_name, info in found.items():
            tool_id = names.get(proc_name)
            if tool_id is not None and tool_id not in presence:
                presence[tool_id] = info
        changed = self._set_presence(presence)
        if self._check_pending_new():
            changed = True
        if self._ensure_active():
            changed = True
        return changed

    def _set_presence(self, presence: dict) -> bool:
        now = time.time()
        # Keep the original first-seen time per tool for stable timestamps.
        self._presence_since = {
            tid: self._presence_since.get(tid, now) for tid in presence
        }
        old = {tid: getattr(info, "pid", None) for tid, info in self._presence.items()}
        new = {tid: getattr(info, "pid", None) for tid, info in presence.items()}
        if old == new:
            # Same pids, but cwd may have moved; keep the fresher info.
            self._presence = presence
            return False
        self._presence = presence
        return True

    def presence(self, tool_id: str | None):
        """Live ProcInfo for a tool, or None when an adapter owns it.

        Discovered on-disk sessions are history, not a live-process source;
        they must not suppress the current process record.
        """
        if tool_id is None:
            return None
        if any(r.status.tool == tool_id for r in self._records.values()):
            return None  # adapter data wins
        return self._presence.get(tool_id)

    # -- session discovery (CLI on-disk stores) -------------------------------

    def refresh_discovery(self) -> bool:
        """Scan CLI session stores; returns True if discovered sessions changed.

        State rule: a discovered session is "running" only while its mtime
        is recent AND the tool has a live process; otherwise "idle".
        Adapter suppression happens at query time, not here.
        """
        if self._discovery is None or self.config is None:
            return self._set_discovered({})
        tool_ids = [t.id for t in self.config.tools if t.discover]
        try:
            found = self._discovery.scan(tool_ids)
        except Exception as exc:  # noqa: BLE001 - discovery is best-effort
            log.warning("session discovery failed: %s", exc)
            return False
        now = time.time()
        records: dict[str, SessionRecord] = {}
        for tool_id, sessions in found.items():
            live = self._presence.get(tool_id) is not None
            for s in sessions:
                updated = int(getattr(s, "updated", 0) or 0)
                state = (
                    "running"
                    if live and updated and now - updated <= DISCOVERED_RECENT_SEC
                    else "idle"
                )
                stable_id = str(getattr(s, "id", "") or "")
                sid = self._discovered_sid(tool_id, stable_id, records)
                name = str(getattr(s, "name", "") or stable_id[:12])
                status = protocol.SessionStatus(
                    tool=tool_id,
                    state=state,
                    session=name,
                    ctx_pct=-1,
                    cost_usd=float(getattr(s, "cost_usd", -1.0) or -1.0),
                    last=str(getattr(s, "last", "") or ""),
                    updated=updated,
                    tail=[str(t) for t in (getattr(s, "tail", None) or [])],
                )
                raw: dict = {
                    "id": sid,
                    "disc_id": stable_id,
                    "tool": tool_id,
                    "session": name,
                    "state": state,
                    "updated": updated,
                }
                if live:
                    # Give discovered sessions the presence delivery target.
                    info = self._presence.get(tool_id)
                    tty = str(getattr(info, "tty", "") or "")
                    if tty:
                        raw["tty"] = tty
                        raw["pid"] = getattr(info, "pid", 0)
                records[sid] = SessionRecord(id=sid, status=status, raw=raw, mtime=float(updated))
        changed = self._set_discovered(records)
        if self._check_pending_new():
            changed = True
        if self._ensure_active():
            changed = True
        if self._merge_discovered_tails():
            changed = True
        return changed

    @staticmethod
    def _discovered_sid(tool_id: str, stable_id: str, existing: dict) -> str:
        """Compact, firmware-safe discovered id: "disc:" + 6..10 hex chars.

        11 chars max so it survives the device's 12-char id buffer round
        trip. Hash covers tool + stable id; extend defensively on the
        (astronomically unlikely) collision within one scan.
        """
        import hashlib

        digest = hashlib.sha1(f"{tool_id}:{stable_id}".encode()).hexdigest()
        for length in (6, 8, 10):
            sid = f"{DISCOVERED_ID_PREFIX}{digest[:length]}"
            if sid not in existing:
                return sid
        return f"{DISCOVERED_ID_PREFIX}{digest[:10]}"

    def _set_discovered(self, records: dict[str, SessionRecord]) -> bool:
        old = {i: (r.status.updated, r.status.state) for i, r in self._discovered.items()}
        new = {i: (r.status.updated, r.status.state) for i, r in records.items()}
        self._discovered = records
        return old != new

    def _discovered_ids_for(self, tool_id: str | None) -> list[str]:
        """Discovered session ids for a tool, newest first.

        Empty when the tool has adapter session files (adapter data wins,
        so no duplicate entries).
        """
        if not tool_id:
            return []
        if any(r.status.tool == tool_id for r in self._records.values()):
            return []
        ids = [i for i, r in self._discovered.items() if r.status.tool == tool_id]
        ids.sort(
            key=lambda i: self._discovered[i].status.updated or self._discovered[i].mtime,
            reverse=True,
        )
        return ids

    def _presence_record(self, tool_id: str | None) -> SessionRecord | None:
        """Synthesize one session record for a presence-only tool.

        Id "proc:<pid>", name from the process cwd label, state idle.
        Process existence alone does not establish that an AI CLI is
        generating: adapters provide the authoritative running/waiting state.
        The process environment may provide a zellij or tty delivery target.
        """
        info = self.presence(tool_id)
        if info is None or tool_id is None:
            return None
        since = self._presence_since.get(tool_id, time.time())
        label_fn = getattr(info, "session_label", None)
        label = label_fn() if callable(label_fn) else (getattr(info, "cwd_basename", "") or "")
        status = protocol.SessionStatus(
            tool=tool_id,
            state="idle",
            session=label,
            ctx_pct=-1,
            cost_usd=-1.0,
            last="",
            updated=int(since),
        )
        raw = {
            "id": f"{PRESENCE_ID_PREFIX}{info.pid}",
            "tool": tool_id,
            "session": label,
            "state": "idle",
            "updated": int(since),
            "pid": info.pid,
        }
        tty = str(getattr(info, "tty", "") or "")
        if tty:
            raw["tty"] = tty
        if getattr(info, "zellij", ""):
            raw["zellij"] = info.zellij
            raw["zellij_pane"] = getattr(info, "zellij_pane", "")
        return SessionRecord(id=raw["id"], status=status, raw=raw, mtime=since)

    def _record_for(self, session_id: str | None) -> SessionRecord | None:
        """Resolve a session id to a record (adapter, discovered, presence)."""
        if session_id is None:
            return None
        if session_id in self._records:
            return self._records[session_id]
        if session_id.startswith(DISCOVERED_ID_PREFIX):
            return self._discovered.get(session_id)
        if session_id.startswith(PRESENCE_ID_PREFIX):
            rec = self._presence_record(self.selected_tool)
            if rec is not None and rec.id == session_id:
                return rec
        return None

    def _selected_ids(self) -> list[str]:
        """Ordered session ids visible for the current selection.

        Per-tool precedence: adapter files > discovered sessions >
        presence (one synthesized "proc:<pid>" entry).
        """
        ids = self._ordered_ids()
        if self.config is None:
            return ids
        ids = [i for i in ids if self._records[i].status.tool == self.selected_tool]
        if not ids:
            ids = self._discovered_ids_for(self.selected_tool)
        # A live CLI is the user's current session.  Keep discovered history,
        # but never let stale on-disk sessions hide it (notably opencode.db).
        rec = self._presence_record(self.selected_tool)
        if rec is not None:
            return [rec.id] + ids
        return ids

    def _ensure_active(self) -> bool:
        ids = self._selected_ids()
        if self.active_id in ids:
            return False
        new_active = next(iter(ids), None)
        if new_active == self.active_id:
            return False
        self.active_id = new_active
        return True

    # -- foreground (fg) marking ------------------------------------------------

    def fg_for(self, rec: SessionRecord) -> bool:
        """Whether a session is live in the foreground (v2.1 `fg`).

        Adapter-reported `fg` in the session file wins; presence-sourced
        sessions are trivially live; otherwise heuristic: record mtime is
        recent (< 3 min) and the tool's process is alive.
        """
        raw_fg = rec.raw.get("fg")
        if raw_fg is not None:
            return bool(raw_fg)
        if rec.id.startswith(PRESENCE_ID_PREFIX):
            return True
        if self._presence.get(rec.status.tool) is None:
            return False
        return (time.time() - rec.mtime) < FG_RECENT_SEC

    # -- dashboard queries -------------------------------------------------------

    def visible_tools(self):
        """Public alias for the configured, non-hidden tools."""
        return self._visible_tools()

    def sessions_for_tool(self, tool_id: str) -> list[SessionRecord]:
        """All sessions of a tool (adapter > discovered > presence)."""
        ids = [i for i in self._ordered_ids() if self._records[i].status.tool == tool_id]
        if not ids:
            ids = self._discovered_ids_for(tool_id)
        records = [r for r in (self._record_for(i) for i in ids) if r is not None]
        rec = self._presence_record(tool_id)
        if rec is not None:
            records = [rec] + records
        return records

    def adapter_online(self, tool_id: str, fresh_sec: float = 600.0) -> bool:
        """True when the tool has a recently-updated adapter session file."""
        now = time.time()
        return any(
            r.status.tool == tool_id and now - r.mtime < fresh_sec
            for r in self._records.values()
        )

    def delivery_target_for(self, tool_id: str) -> str | None:
        """Best available delivery transport for a tool: "tmux" | "tty" | None."""
        has_tty = False
        for rec in self.sessions_for_tool(tool_id):
            if rec.raw.get("tmux"):
                return "tmux"
            if rec.raw.get("tty"):
                has_tty = True
        return "tty" if has_tty else None

    # -- session.new ------------------------------------------------------------

    def tmux_target_for_selected(self) -> str | None:
        """A tmux pane anchor for the selected tool (active session first)."""
        if self.config is None:
            return None
        candidates = []
        active = self.active()
        if active is not None:
            candidates.append(active)
        candidates.extend(self._records[i] for i in self._selected_ids())
        for rec in candidates:
            pane = str(rec.raw.get("tmux") or "")
            if pane:
                return pane
        return None

    def request_new_session(self) -> None:
        """Arm pending selection: the next new session of the selected tool
        (appearing via adapter files or discovery) becomes active."""
        self._pending_new = (
            self.selected_tool or "",
            frozenset(self._selected_ids()),
            time.time() + NEW_SESSION_TIMEOUT_SEC,
        )

    def _check_pending_new(self) -> bool:
        if self._pending_new is None:
            return False
        tool_id, known, deadline = self._pending_new
        if time.time() > deadline:
            self._pending_new = None
            return False
        if tool_id != self.selected_tool:
            return False  # user navigated away; keep waiting until deadline
        new_ids = [i for i in self._selected_ids() if i not in known]
        if not new_ids:
            return False
        self.active_id = new_ids[0]  # _selected_ids is most-recent first
        self._pending_new = None
        log.info("session.new: selected new session %s", self.active_id)
        return True

    # -- file watching -----------------------------------------------------

    def poll(self) -> bool:
        """Reload changed session files. Returns True if anything changed."""
        changed = False
        now = time.time()
        try:
            files = sorted(self.dir.glob("*.json"))
        except OSError:
            return False

        seen: set[str] = set()
        for path in files:
            seen.add(path.name)
            try:
                mtime = path.stat().st_mtime
            except OSError:
                continue
            if self._mtimes.get(path.name) == mtime:
                continue
            self._mtimes[path.name] = mtime
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                log.warning("ignoring unreadable session file %s: %s", path, exc)
                continue
            session_id = str(data.get("id") or path.stem)
            status = protocol.SessionStatus.from_dict(data)
            if not status.updated:
                status.updated = int(mtime)
            self._records[session_id] = SessionRecord(
                id=session_id, status=status, raw=data, mtime=mtime
            )
            self._files[path.name] = session_id
            changed = True

        # Remove sessions whose files were deleted.
        for name in set(self._mtimes) - seen:
            del self._mtimes[name]
            session_id = self._files.pop(name, None)
            if session_id is not None and session_id in self._records:
                del self._records[session_id]
                changed = True

        # Prune stale sessions (no update for >30min).
        for session_id in list(self._records):
            rec = self._records[session_id]
            last_update = rec.status.updated or rec.mtime
            if now - last_update > STALE_AFTER_SEC:
                log.info("pruning stale session %s", session_id)
                del self._records[session_id]
                changed = True

        if self._check_pending_new():
            changed = True
        if self._ensure_active():
            changed = True
        if self._merge_discovered_tails():
            changed = True
        return changed

    def _merge_discovered_tails(self) -> bool:
        """Fill adapter records' empty tail/last from discovery.

        Adapter files carry rich live state but no conversation tail;
        discovery parses tails from the CLI's own transcripts. When both
        describe the same session (kimi: adapter id == session dir name),
        discovery is suppressed from the list — merge its tail into the
        adapter record so the device reader has content.
        """
        if not self._discovered:
            return False
        by_stable: dict[tuple[str, str], SessionRecord] = {}
        for drec in self._discovered.values():
            stable = str(drec.raw.get("disc_id") or "")
            if stable and drec.status.tail:
                by_stable.setdefault((drec.status.tool, stable), drec)
        changed = False
        for rec in self._records.values():
            if rec.status.tail:
                continue
            drec = by_stable.get((rec.status.tool, rec.id))
            if drec is None:
                continue
            rec.status.tail = list(drec.status.tail)
            if not rec.status.last and drec.status.last:
                rec.status.last = drec.status.last
            changed = True
        return changed

    def _ordered_ids(self) -> list[str]:
        """Session ids in stable order (most recently updated first)."""
        return [
            r.id
            for r in sorted(
                self._records.values(),
                key=lambda r: r.status.updated or r.mtime,
                reverse=True,
            )
        ]

    # -- queries ------------------------------------------------------------

    def sessions(self) -> list[SessionRecord]:
        """Adapter sessions, then discovered ones (adapter-suppressed tools excluded)."""
        records = [self._records[i] for i in self._ordered_ids()]
        adapter_tools = {r.status.tool for r in records}
        extra = [r for r in self._discovered.values() if r.status.tool not in adapter_tools]
        extra.sort(key=lambda r: r.status.updated or r.mtime, reverse=True)
        return records + extra

    def active(self) -> SessionRecord | None:
        return self._record_for(self.active_id) if self.active_id else None

    def status_payload(self) -> str:
        rec = self.active()
        if rec is not None:
            return rec.status.to_json()
        return protocol.SessionStatus(
            tool=self.selected_tool or "", state="idle"
        ).to_json()

    def sessions_payload(self) -> str:
        ids = self._selected_ids()
        active_idx = ids.index(self.active_id) if self.active_id in ids else 0
        payload = protocol.SessionsPayload(
            active=active_idx,
            list=[
                protocol.SessionInfo(
                    id=rec.id,
                    tool=rec.status.tool,
                    name=rec.status.session or rec.id,
                    state=rec.status.state,
                    fg=self.fg_for(rec),
                )
                for rec in (self._record_for(i) for i in ids)
                if rec is not None
            ],
        )
        return payload.to_json()

    def tools_payload(self) -> str:
        """TOOLS payload: visible configured tools with aggregate state."""
        if self.config is None:
            return protocol.ToolsPayload().to_json()
        voice_enabled = self.config.features.voice_enabled
        adapter_tools = {r.status.tool for r in self._records.values()}
        discovered_tools = {r.status.tool for r in self._discovered.values()}
        merged = list(self._records.values()) + [
            r for r in self._discovered.values() if r.status.tool not in adapter_tools
        ]
        states: dict[str, str] = {}
        for rec in merged:
            tool = rec.status.tool
            state = rec.status.state
            cur = states.get(tool)
            if cur is None or _STATE_PRIORITY.index(state if state in _STATE_PRIORITY else "idle") < _STATE_PRIORITY.index(cur):
                states[tool] = state if state in _STATE_PRIORITY else "idle"
        visible = self._visible_tools()
        tools = []
        for t in visible:
            state = states.get(t.id)
            if (
                t.id not in adapter_tools
                and t.id not in discovered_tools
                and self._presence.get(t.id) is not None
            ):
                # A live CLI process is selectable and foreground, but it is
                # not evidence that the CLI is currently generating.  Only an
                # adapter/discovered transcript may report running/waiting.
                state = "idle"
            elif state is None:
                state = "idle"
            tools.append(
                protocol.ToolInfo(id=t.id, name=t.name, state=state, fns=t.fns(voice_enabled))
            )
        active = 0
        for i, t in enumerate(visible):
            if t.id == self.selected_tool:
                active = i
                break
        return protocol.ToolsPayload(active=active, list=tools).to_json()

    # -- commands -------------------------------------------------------------

    def apply_command(self, cmd: dict) -> bool:
        """Apply a COMMAND payload. Returns True if the selection changed."""
        name = cmd.get("cmd")
        if name == protocol.CMD_REFRESH:
            return False  # caller re-sends current payloads
        if name == protocol.CMD_TOOL_NEXT:
            return self._select_tool_delta(1)
        if name == protocol.CMD_TOOL_SELECT:
            return self._select_tool(str(cmd.get("id", "")))
        if name in (protocol.CMD_NEXT, protocol.CMD_PREV, protocol.CMD_SELECT):
            return self._apply_session_command(name, cmd)
        log.warning("unknown command %r", name)
        return False

    def _select_tool_delta(self, delta: int) -> bool:
        tools = self._visible_tools()
        if not tools:
            log.warning("tool command without configured tools")
            return False
        ids = [t.id for t in tools]
        cur = ids.index(self.selected_tool) if self.selected_tool in ids else 0
        return self._select_tool(ids[(cur + delta) % len(ids)])

    def _select_tool(self, tool_id: str) -> bool:
        if self.config is None or tool_id not in {t.id for t in self._visible_tools()}:
            log.warning("tool.select for unknown id %r", tool_id)
            return False
        if tool_id == self.selected_tool and not self._ensure_active():
            return False
        self.selected_tool = tool_id
        self.active_id = next(iter(self._selected_ids()), None)
        return True

    def _apply_session_command(self, name: str, cmd: dict) -> bool:
        ids = self._selected_ids()
        if not ids:
            return False
        cur = ids.index(self.active_id) if self.active_id in ids else 0
        if name == protocol.CMD_NEXT:
            self.active_id = ids[(cur + 1) % len(ids)]
        elif name == protocol.CMD_PREV:
            self.active_id = ids[(cur - 1) % len(ids)]
        elif name == protocol.CMD_SELECT:
            target = str(cmd.get("id", ""))
            if target not in ids:
                # The firmware truncates session ids to its 12-char buffer
                # (11 usable chars); accept a unique-prefix match.
                matches = [i for i in ids if i.startswith(target)]
                if len(matches) == 1:
                    target = matches[0]
                else:
                    log.warning("session.select for unknown id %r", target)
                    return False
            self.active_id = target
        return True
