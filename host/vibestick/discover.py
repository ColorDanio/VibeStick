"""Session discovery: reads CLIs' own on-disk session stores.

Adapter session files only exist when a CLI was launched through an
adapter; discovery fills the gap by reading the transcripts/databases
the CLIs write themselves. Everything here is defensive: weird or
unreadable files are skipped, never fatal. Roots are injectable so
tests use fixture trees instead of the real home directory.

Per-tool layouts (as found on a real machine):

- claude-code: ~/.claude/projects/<encoded-project>/<session-uuid>.jsonl
  JSONL transcript; entries carry "cwd"; assistant entries look like
  {"type":"assistant","message":{"content":[{"type":"text","text":...}]}}.
- codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
  First line: {"type":"session_meta","payload":{"session_id","cwd"}}.
  Assistant messages: {"type":"response_item","payload":{"type":"message",
  "role":"assistant","content":[{"type":"output_text","text":...}]}}.
- kimi-cli: ~/.kimi-code/sessions/wd_<project>_<hash>/session_<uuid>/
  with state.json {"title","updatedAt"} (best-effort, no deep parsing).
- opencode: ~/.local/share/opencode/opencode.db (sqlite, stdlib driver,
  read-only): table "session" with id/title/directory/time_updated(ms)/cost.
"""

from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path

from . import protocol

log = logging.getLogger(__name__)

MAX_SESSIONS_PER_TOOL = 10
TAIL_BYTES = 16384  # tail window when looking for the last assistant message
LAST_MAX_CHARS = 120

SCANNERS = ("claude-code", "codex", "kimi-cli", "opencode")

# User-message blobs that are system injections, not conversation.
_NOISE_PREFIXES = (
    "<environment_context", "<system-reminder", "<untrusted", "<goal",
    "<command-", "<local-command", "<user_", "<available-", "<budget",
)


_TAG_RE = re.compile(r"<[^>]+>")
_MDLINK_RE = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_URL_RE = re.compile(r"https?://\S+")
_MD_RE = re.compile(r"(\*\*|__|##+|`|~~)")


def _sanitize_text(text: str) -> str:
    """Strip HTML/XML tags, markdown emphasis/links, compress URLs, fold
    whitespace — readable plain text for the small device screen."""
    text = _TAG_RE.sub(" ", text)
    text = _MDLINK_RE.sub(r"\1", text)
    text = _URL_RE.sub("[link]", text)
    text = _MD_RE.sub("", text)
    return " ".join(text.split())


def _clean_message_text(text: str) -> str | None:
    """Collapse whitespace; None for system-injection noise messages."""
    low = str(text).lower()
    if low.lstrip().startswith(_NOISE_PREFIXES) or "<system-reminder>" in low:
        return None
    text = _sanitize_text(text)
    return text or None


def _tail_from_jsonl(path: Path, extract, n: int = protocol.TAIL_MAX_ITEMS) -> list[str]:
    """Last n conversation lines from a JSONL transcript.

    `extract(entry) -> (role, text) | None`. Oldest first, each item
    prefixed "user: "/"assistant: " (the firmware colors by prefix).
    """
    hits: list[tuple[str, str]] = []
    try:
        for line in reversed(_read_tail(path)):
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            hit = extract(entry)
            if hit is not None:
                hits.append(hit)
            if len(hits) >= n:
                break
    except OSError:
        return []
    hits.reverse()
    return [
        f"{role}: {_clip(text, protocol.TAIL_ITEM_MAX_CHARS)}" for role, text in hits
    ]


def default_roots(home: Path | None = None) -> dict[str, Path]:
    home = home or Path.home()
    return {
        "claude-code": home / ".claude" / "projects",
        "codex": home / ".codex" / "sessions",
        "kimi-cli": home / ".kimi-code" / "sessions",
        "opencode": home / ".local" / "share" / "opencode",
    }


@dataclass
class DiscoveredSession:
    """One session found in a tool's on-disk store (pre-state assignment)."""

    id: str  # stable tool-specific id (uuid / ses_* / dir name)
    tool: str
    name: str
    last: str = ""  # last assistant message snippet, "" when unknown
    updated: int = 0  # epoch seconds
    cost_usd: float = -1.0
    tail: list[str] = field(default_factory=list)  # recent conversation lines


class SessionDiscovery:
    """Scans CLI session stores; caches per-file parses keyed by mtime."""

    def __init__(self, roots: dict[str, Path] | None = None) -> None:
        self.roots = roots or default_roots()
        self._cache: dict[str, tuple[float, str, str, float]] = {}  # path -> (mtime, name, last, cost)

    def scan(self, tool_ids: list[str]) -> dict[str, list[DiscoveredSession]]:
        """Return {tool_id: [DiscoveredSession, ...]} (newest first, capped)."""
        out: dict[str, list[DiscoveredSession]] = {}
        for tool_id in tool_ids:
            scanner = _SCANNERS.get(tool_id)
            root = self.roots.get(tool_id)
            if scanner is None or root is None:
                continue
            try:
                sessions = scanner(self, Path(root))
            except Exception as exc:  # noqa: BLE001 - discovery is best-effort
                log.warning("discovery scan for %s failed: %s", tool_id, exc)
                continue
            sessions.sort(key=lambda s: s.updated, reverse=True)
            out[tool_id] = sessions[:MAX_SESSIONS_PER_TOOL]
        return out

    # -- shared helpers ---------------------------------------------------

    def _recent_files(self, root: Path, pattern: str) -> list[Path]:
        """Glob `pattern` under root, newest mtime first (capped shortlist)."""
        try:
            candidates = []
            for path in root.glob(pattern):
                try:
                    candidates.append((path.stat().st_mtime, path))
                except OSError:
                    continue
        except OSError:
            return []
        candidates.sort(reverse=True)
        return [p for _, p in candidates[: MAX_SESSIONS_PER_TOOL * 2]]

    def _meta(self, path: Path, parse) -> tuple[str, str, float, list]:
        """(name, last, cost, tail) for a transcript file, cached by path+mtime."""
        try:
            mtime = path.stat().st_mtime
        except OSError:
            return "", "", -1.0, []
        cached = self._cache.get(str(path))
        if cached and cached[0] == mtime:
            return cached[1], cached[2], cached[3], cached[4]
        try:
            name, last, cost, tail = parse(path)
        except Exception as exc:  # noqa: BLE001 - one weird file must not kill the scan
            log.debug("cannot parse %s: %s", path, exc)
            name, last, cost, tail = "", "", -1.0, []
        self._cache[str(path)] = (mtime, name, last, cost, tail)
        return name, last, cost, tail


def _read_tail(path: Path) -> list[str]:
    """Lines from the tail of a (possibly large) file."""
    with open(path, "rb") as f:
        f.seek(0, os.SEEK_END)
        size = f.tell()
        f.seek(max(0, size - TAIL_BYTES))
        data = f.read()
    return data.decode("utf-8", errors="replace").splitlines()


def _read_head(path: Path, max_lines: int = 50) -> list[str]:
    lines = []
    with open(path, "rb") as f:
        for i, raw in enumerate(f):
            if i >= max_lines:
                break
            lines.append(raw.decode("utf-8", errors="replace"))
    return lines


def _clip(text: str, max_chars: int = LAST_MAX_CHARS) -> str:
    text = " ".join(text.split())
    return text[:max_chars]


# -- claude-code ------------------------------------------------------------


def _claude_msg(entry: dict) -> tuple[str, str] | None:
    if entry.get("type") not in ("user", "assistant"):
        return None
    content = (entry.get("message") or {}).get("content") or []
    texts = [c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text"]
    text = _clean_message_text(" ".join(texts)) if texts else None
    return (entry["type"], text) if text else None


def _parse_claude(path: Path) -> tuple[str, str, float, list]:
    name = ""
    for line in _read_head(path):
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        cwd = entry.get("cwd")
        if cwd:
            name = os.path.basename(str(cwd).rstrip("/"))
            break
    if not name:  # fall back to the encoded project dir name
        name = path.parent.name.lstrip("-").replace("-", "/")
        name = os.path.basename(name) or path.parent.name
    tail = _tail_from_jsonl(path, _claude_msg)
    last = ""
    for item in reversed(tail):
        if item.startswith("assistant: "):
            last = item[len("assistant: "):]
            break
    return name, last, -1.0, tail


def _scan_claude(disc: SessionDiscovery, root: Path) -> list[DiscoveredSession]:
    out = []
    for path in disc._recent_files(root, "*/*.jsonl"):
        try:
            mtime = path.stat().st_mtime
        except OSError:
            continue
        name, last, _, tail = disc._meta(path, _parse_claude)
        out.append(
            DiscoveredSession(
                id=path.stem, tool="claude-code",
                name=name or path.stem[:8], last=last, updated=int(mtime), tail=tail,
            )
        )
    return out


# -- codex -------------------------------------------------------------------


def _codex_msg(entry: dict) -> tuple[str, str] | None:
    payload = entry.get("payload") or {}
    if payload.get("type") != "message":
        return None
    role = payload.get("role")
    if role not in ("user", "assistant"):
        return None
    texts = [
        c.get("text", "")
        for c in (payload.get("content") or [])
        if isinstance(c, dict) and c.get("text")
    ]
    text = _clean_message_text(" ".join(texts)) if texts else None
    return (role, text) if text else None


def _parse_codex(path: Path) -> tuple[str, str, float, list]:
    name = ""
    for line in _read_head(path, 5):
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if entry.get("type") == "session_meta":
            payload = entry.get("payload") or {}
            cwd = payload.get("cwd")
            if cwd:
                name = os.path.basename(str(cwd).rstrip("/"))
            break
    tail = _tail_from_jsonl(path, _codex_msg)
    last = ""
    for item in reversed(tail):
        if item.startswith("assistant: "):
            last = item[len("assistant: "):]
            break
    return name, last, -1.0, tail


def _scan_codex(disc: SessionDiscovery, root: Path) -> list[DiscoveredSession]:
    out = []
    for path in disc._recent_files(root, "**/rollout-*.jsonl"):
        try:
            mtime = path.stat().st_mtime
        except OSError:
            continue
        name, last, _, tail = disc._meta(path, _parse_codex)
        # rollout-<ts>-<uuid>.jsonl -> uuid as the stable id
        parts = path.stem.split("-")
        session_id = "-".join(parts[-5:]) if len(parts) >= 5 else path.stem
        out.append(
            DiscoveredSession(
                id=session_id, tool="codex",
                name=name or session_id[:8], last=last, updated=int(mtime), tail=tail,
            )
        )
    return out


# -- kimi-cli ----------------------------------------------------------------


def _kimi_msg(entry: dict) -> tuple[str, str] | None:
    if entry.get("type") != "context.append_message":
        return None
    msg = entry.get("message") or {}
    role = msg.get("role")
    if role not in ("user", "assistant"):
        return None
    texts = [
        c.get("text", "")
        for c in (msg.get("content") or [])
        if isinstance(c, dict) and c.get("type") == "text"
    ]
    text = _clean_message_text(" ".join(texts)) if texts else None
    return (role, text) if text else None


def _scan_kimi(disc: SessionDiscovery, root: Path) -> list[DiscoveredSession]:
    out = []
    try:
        wd_dirs = sorted(root.glob("wd_*/session_*/"), key=os.path.getmtime, reverse=True)
    except OSError:
        return []
    for session_dir in wd_dirs[: MAX_SESSIONS_PER_TOOL * 2]:
        try:
            mtime = session_dir.stat().st_mtime
        except OSError:
            continue
        name = ""
        state_file = session_dir / "state.json"
        try:
            state = json.loads(state_file.read_text(encoding="utf-8"))
            name = str(state.get("title") or "").strip()
            mtime = max(mtime, state_file.stat().st_mtime)
        except (OSError, json.JSONDecodeError):
            pass
        if not name:  # wd_<project>_<hash> -> project
            wd = session_dir.parent.name
            name = wd[3:].rsplit("_", 1)[0] if wd.startswith("wd_") else wd
        # Conversation lives in agents/main/wire.jsonl (context.append_message);
        # its mtime is the real activity clock (state.json only changes on
        # title updates, so it goes stale while the session is live).
        wire = session_dir / "agents" / "main" / "wire.jsonl"
        try:
            mtime = max(mtime, wire.stat().st_mtime)
        except OSError:
            pass
        tail = _tail_from_jsonl(wire, _kimi_msg)
        last = ""
        for item in reversed(tail):
            if item.startswith("assistant: "):
                last = item[len("assistant: "):]
                break
        out.append(
            DiscoveredSession(
                id=session_dir.name, tool="kimi-cli",
                name=_clip(name) or session_dir.name[:16], updated=int(mtime),
                last=last, tail=tail,
            )
        )
    return out


# -- opencode -----------------------------------------------------------------


def _opencode_tail(db: sqlite3.Connection, session_id: str) -> list[str]:
    """Last conversation lines: text parts joined with their message role."""
    rows = db.execute(
        "SELECT m.data, p.data FROM part p"
        " JOIN message m ON m.id = p.message_id"
        " WHERE p.session_id = ? ORDER BY p.time_created DESC LIMIT 30",
        (session_id,),
    ).fetchall()
    hits: list[tuple[str, str]] = []
    for msg_data, part_data in rows:
        try:
            msg = json.loads(msg_data)
            part = json.loads(part_data)
        except json.JSONDecodeError:
            continue
        if part.get("type") != "text":
            continue
        role = str(msg.get("role") or "")
        if role not in ("user", "assistant"):
            continue
        text = _clean_message_text(str(part.get("text") or ""))
        if text:
            hits.append((role, text))
        if len(hits) >= protocol.TAIL_MAX_ITEMS:
            break
    hits.reverse()
    return [
        f"{role}: {_clip(text, protocol.TAIL_ITEM_MAX_CHARS)}" for role, text in hits
    ]


def _scan_opencode(disc: SessionDiscovery, root: Path) -> list[DiscoveredSession]:
    db_path = root / "opencode.db"
    if not db_path.exists():
        return []
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        rows = db.execute(
            "SELECT id, title, directory, time_updated, cost FROM session"
            " WHERE time_archived IS NULL"
            " ORDER BY time_updated DESC LIMIT ?",
            (MAX_SESSIONS_PER_TOOL * 2,),
        ).fetchall()
        out = []
        for row in rows:
            session_id, title, directory, time_updated, cost = row[:5]
            name = str(title or "").strip() or (
                os.path.basename(str(directory).rstrip("/")) if directory else ""
            )
            try:
                cost_usd = float(cost)
            except (TypeError, ValueError):
                cost_usd = -1.0
            try:
                tail = _opencode_tail(db, str(session_id))
            except sqlite3.Error as exc:
                log.debug("opencode tail for %s failed: %s", session_id, exc)
                tail = []
            last = ""
            for item in reversed(tail):
                if item.startswith("assistant: "):
                    last = item[len("assistant: "):]
                    break
            out.append(
                DiscoveredSession(
                    id=str(session_id), tool="opencode",
                    name=_clip(name) or str(session_id)[:12],
                    updated=int((time_updated or 0) / 1000),
                    cost_usd=cost_usd, last=last, tail=tail,
                )
            )
    finally:
        db.close()
    return out


_SCANNERS = {
    "claude-code": _scan_claude,
    "codex": _scan_codex,
    "kimi-cli": _scan_kimi,
    "opencode": _scan_opencode,
}
