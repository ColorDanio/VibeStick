"""Protocol definitions matching docs/protocol.md exactly.

All payloads are UTF-8 JSON, one complete document per write/notify,
kept under 512 bytes by trimming optional fields.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

# GATT service and characteristic UUIDs (docs/protocol.md)
SERVICE_UUID = "4b1e0001-5a3f-4c8d-9b6e-7f2a1c0d3e5f"
STATUS_UUID = "4b1e0002-5a3f-4c8d-9b6e-7f2a1c0d3e5f"
SESSIONS_UUID = "4b1e0003-5a3f-4c8d-9b6e-7f2a1c0d3e5f"
INPUT_UUID = "4b1e0004-5a3f-4c8d-9b6e-7f2a1c0d3e5f"
COMMAND_UUID = "4b1e0005-5a3f-4c8d-9b6e-7f2a1c0d3e5f"
TOOLS_UUID = "4b1e0006-5a3f-4c8d-9b6e-7f2a1c0d3e5f"
VOICE_UUID = "4b1e0007-5a3f-4c8d-9b6e-7f2a1c0d3e5f"
AUDIO_UUID = "4b1e0008-5a3f-4c8d-9b6e-7f2a1c0d3e5f"

DEVICE_NAME = "VibeStick"
MAX_PAYLOAD = 512

# `ready` is used only by TOOLS: it means an idle, selectable session exists.
# STATUS / SESSIONS retain idle for a non-generating CLI.
STATES = ("idle", "ready", "running", "waiting", "error")

# Input (device -> daemon) types and commands
INPUT_MESSAGE = "message"
INPUT_KEY = "key"
CMD_NEXT = "session.next"
CMD_PREV = "session.prev"
CMD_SELECT = "session.select"
CMD_REFRESH = "refresh"
CMD_TOOL_NEXT = "tool.next"
CMD_TOOL_SELECT = "tool.select"
CMD_FN_ACTIVATE = "fn.activate"
CMD_VOICE_START = "voice.start"
CMD_VOICE_STOP = "voice.stop"
CMD_VOICE_CONFIRM = "voice.confirm"
CMD_VOICE_CANCEL = "voice.cancel"
CMD_INFERENCE_CANCEL = "inference.cancel"
CMD_SESSION_NEW = "session.new"

VOICE_COMMANDS = (CMD_VOICE_START, CMD_VOICE_STOP, CMD_VOICE_CONFIRM, CMD_VOICE_CANCEL)

# Well-known function ids in the TOOLS payload; any other id is a custom
# key binding configured on the host.
WELL_KNOWN_FNS = ("status", "sessions", "voice")

# Voice pipeline states (VOICE payload, daemon -> device)
VOICE_STATES = ("idle", "recording", "transcribing", "ready", "error")

# AUDIO payload format (device -> daemon, binary)
AUDIO_SAMPLE_RATE = 8000  # 8 kHz, 8-bit unsigned, mono

LAST_MAX_CHARS = 80  # `last` truncated to ~80 chars per protocol doc
TAIL_ITEM_MAX_CHARS = 60  # v2.2 `tail` items pre-clipped to ~60 chars
TAIL_MAX_ITEMS = 5  # 3-5 recent lines is the sweet spot for the device


def _dumps(obj: dict) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def _truncate(text: str, max_chars: int) -> str:
    return text if len(text) <= max_chars else text[: max_chars - 1] + "…"


@dataclass
class SessionStatus:
    """STATUS payload (daemon -> device)."""

    tool: str
    model: str = ""
    session: str = ""
    state: str = "idle"
    ctx_pct: int = -1  # 0-100, -1 unknown
    cost_usd: float = -1.0  # -1 unknown
    last: str = ""  # last assistant action, ~80 chars max
    updated: int = 0  # unix epoch seconds
    tail: list[str] = field(default_factory=list)  # v2.2: recent conversation lines
    queued: int = 0  # v2.2: host-side send-queue depth for this session

    def to_dict(self) -> dict:
        d = {
            "tool": self.tool,
            "model": self.model,
            "session": self.session,
            "state": self.state,
            "ctx_pct": self.ctx_pct,
            "cost_usd": self.cost_usd,
            "last": self.last,
            "updated": self.updated,
        }
        if self.tail:
            d["tail"] = list(self.tail)
        if self.queued:
            d["queued"] = self.queued
        return d

    @classmethod
    def from_dict(cls, data: dict) -> "SessionStatus":
        return cls(
            tool=str(data.get("tool", "")),
            model=str(data.get("model", "")),
            session=str(data.get("session", "")),
            state=str(data.get("state", "idle")),
            ctx_pct=int(data.get("ctx_pct", -1)),
            cost_usd=float(data.get("cost_usd", -1)),
            last=str(data.get("last", "")),
            updated=int(data.get("updated", 0)),
            tail=[str(t) for t in data.get("tail", [])],
            queued=int(data.get("queued", 0)),
        )

    @classmethod
    def from_json(cls, payload: str | bytes) -> "SessionStatus":
        return cls.from_dict(json.loads(payload))

    def to_json(self) -> str:
        """Compact JSON, trimmed to fit within MAX_PAYLOAD bytes.

        Trimming order: clip tail items to 60 chars, drop oldest tail
        entries, truncate `last` to 80 chars, drop `last`, drop `model`,
        drop `session`, drop `ctx_pct`/`cost_usd`.
        """
        d = self.to_dict()
        if "tail" in d:
            d["tail"] = [_truncate(str(t), TAIL_ITEM_MAX_CHARS) for t in d["tail"]]
        d["last"] = _truncate(str(d["last"]), LAST_MAX_CHARS)
        out = _dumps(d)
        while "tail" in d and d["tail"] and len(out.encode("utf-8")) > MAX_PAYLOAD:
            d["tail"] = d["tail"][1:]  # drop the oldest tail entry
            out = _dumps(d)
        if "tail" in d and not d["tail"]:
            del d["tail"]
            out = _dumps(d)
        if len(out.encode("utf-8")) <= MAX_PAYLOAD:
            return out
        for key in ("last", "model", "session"):
            d[key] = ""
            out = _dumps(d)
            if len(out.encode("utf-8")) <= MAX_PAYLOAD:
                return out
        d["ctx_pct"] = -1
        d["cost_usd"] = -1
        return _dumps(d)


@dataclass
class SessionInfo:
    """One entry in the SESSIONS payload list."""

    id: str
    tool: str
    name: str
    state: str = "idle"
    fg: bool = False  # v2.1: live in the foreground (active dot on device)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "tool": self.tool,
            "name": self.name,
            "state": self.state,
            "fg": self.fg,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "SessionInfo":
        return cls(
            id=str(data.get("id", "")),
            tool=str(data.get("tool", "")),
            name=str(data.get("name", "")),
            state=str(data.get("state", "idle")),
            fg=bool(data.get("fg", False)),
        )


@dataclass
class SessionsPayload:
    """SESSIONS payload (daemon -> device)."""

    active: int = 0
    list: list[SessionInfo] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"active": self.active, "list": [s.to_dict() for s in self.list]}

    @classmethod
    def from_dict(cls, data: dict) -> "SessionsPayload":
        return cls(
            active=int(data.get("active", 0)),
            list=[SessionInfo.from_dict(s) for s in data.get("list", [])],
        )

    @classmethod
    def from_json(cls, payload: str | bytes) -> "SessionsPayload":
        return cls.from_dict(json.loads(payload))

    def to_json(self) -> str:
        """Compact JSON, trimmed to fit within MAX_PAYLOAD bytes.

        Trimming order: truncate names to 40 chars, then drop tail
        entries (keeping the active entry) until it fits.
        """
        entries = [s.to_dict() for s in self.list]
        for e in entries:
            e["name"] = _truncate(str(e["name"]), 40)
        active = self.active

        out = _dumps({"active": active, "list": entries})
        while len(out.encode("utf-8")) > MAX_PAYLOAD and len(entries) > 1:
            # Drop a non-active entry, preferring the tail.
            idx = len(entries) - 1
            if idx == active:
                idx -= 1
                if idx < 0:
                    break
            entries.pop(idx)
            if active > idx:
                active -= 1
            out = _dumps({"active": active, "list": entries})
        return out


@dataclass
class ToolInfo:
    """One entry in the TOOLS payload list."""

    id: str
    name: str
    state: str = "idle"
    fns: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"id": self.id, "name": self.name, "state": self.state, "fns": list(self.fns)}

    @classmethod
    def from_dict(cls, data: dict) -> "ToolInfo":
        return cls(
            id=str(data.get("id", "")),
            name=str(data.get("name", "")),
            state=str(data.get("state", "idle")),
            fns=[str(f) for f in data.get("fns", [])],
        )


@dataclass
class ToolsPayload:
    """TOOLS payload (daemon -> device)."""

    active: int = 0
    list: list[ToolInfo] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {"active": self.active, "list": [t.to_dict() for t in self.list]}

    @classmethod
    def from_dict(cls, data: dict) -> "ToolsPayload":
        return cls(
            active=int(data.get("active", 0)),
            list=[ToolInfo.from_dict(t) for t in data.get("list", [])],
        )

    @classmethod
    def from_json(cls, payload: str | bytes) -> "ToolsPayload":
        return cls.from_dict(json.loads(payload))

    def to_json(self) -> str:
        """Compact JSON, trimmed to fit within MAX_PAYLOAD bytes.

        Trimming order: truncate names to 24 chars, then drop tail
        entries (keeping the active entry) until it fits.
        """
        entries = [t.to_dict() for t in self.list]
        for e in entries:
            e["name"] = _truncate(str(e["name"]), 24)
        active = self.active

        out = _dumps({"active": active, "list": entries})
        while len(out.encode("utf-8")) > MAX_PAYLOAD and len(entries) > 1:
            idx = len(entries) - 1
            if idx == active:
                idx -= 1
                if idx < 0:
                    break
            entries.pop(idx)
            if active > idx:
                active -= 1
            out = _dumps({"active": active, "list": entries})
        return out


@dataclass
class VoicePayload:
    """VOICE payload (daemon -> device): voice pipeline state."""

    state: str = "idle"
    text: str = ""

    def to_dict(self) -> dict:
        return {"state": self.state, "text": self.text}

    @classmethod
    def from_dict(cls, data: dict) -> "VoicePayload":
        return cls(state=str(data.get("state", "idle")), text=str(data.get("text", "")))

    @classmethod
    def from_json(cls, payload: str | bytes) -> "VoicePayload":
        return cls.from_dict(json.loads(payload))

    def to_json(self) -> str:
        d = self.to_dict()
        d["text"] = _truncate(str(d["text"]), 200)
        return _dumps(d)
