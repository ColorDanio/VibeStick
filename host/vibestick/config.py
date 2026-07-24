"""Daemon configuration: ~/.vibestick/config.json (docs/protocol.md).

Loaded on daemon start (created with defaults on first run), editable via
the setup UI. Parsing is defensive: recoverable problems are coerced or
dropped with a warning; a fundamentally unreadable file falls back to the
defaults without overwriting the user's file. Writes are atomic.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from . import protocol

log = logging.getLogger(__name__)

DEFAULT_PATH = Path.home() / ".vibestick" / "config.json"

ADAPTERS = ("statusline", "wrapper")

# Well-known executable names per tool id, used by the process presence
# watcher and as a fallback for configs written before it existed.
DEFAULT_PROCESSES = {
    "claude-code": "claude",
    "codex": "codex",
    "opencode": "opencode",
    "kimi-cli": "kimi",
}
ASR_ENGINES = ("faster-whisper", "command")
WHISPER_MODELS = ("tiny", "base", "small")


class ConfigError(ValueError):
    """Raised when a config document is structurally unusable."""


@dataclass
class ToolConfig:
    id: str
    name: str
    adapter: str = "wrapper"
    bindings: dict[str, str] = field(default_factory=dict)
    delivery_hint: str = ""  # informational note shown in the setup UI
    process: str = ""  # executable name for the process presence watcher
    hidden: bool = False  # hidden tools are omitted from TOOLS and the carousel
    discover: bool = True  # discover sessions from the tool's on-disk store
    command: str = ""  # CLI launch command for session.new (default: process name)
    delivery: str = "auto"  # delivery target preference: auto | tmux | tty
    aliases: list[str] = field(default_factory=list)  # extra process names to match

    def fns(self, voice_enabled: bool = True) -> list[str]:
        """TOOLS payload function ids: well-known fns + sorted binding ids.

        The reserved "cancel" binding (inference.cancel key) is host-side
        only and never shown as a device function.
        """
        fns = [f for f in protocol.WELL_KNOWN_FNS if voice_enabled or f != "voice"]
        return fns + sorted(k for k in self.bindings if k != "cancel")

    def launch_command(self) -> str:
        """CLI launch command for session.new (explicit, else process name)."""
        return self.command or self.process

    def to_dict(self) -> dict:
        d: dict = {
            "id": self.id,
            "name": self.name,
            "adapter": self.adapter,
            "bindings": dict(self.bindings),
        }
        if self.delivery_hint:
            d["delivery_hint"] = self.delivery_hint
        if self.process:
            d["process"] = self.process
        if self.hidden:
            d["hidden"] = True
        if not self.discover:
            d["discover"] = False
        if self.command:
            d["command"] = self.command
        if self.delivery != "auto":
            d["delivery"] = self.delivery
        if self.aliases:
            d["aliases"] = list(self.aliases)
        return d

    @classmethod
    def from_dict(cls, data: object) -> "ToolConfig":
        if not isinstance(data, dict):
            raise ConfigError(f"tool entry must be an object, got {type(data).__name__}")
        tool_id = str(data.get("id") or "").strip()
        if not tool_id:
            raise ConfigError("tool entry missing non-empty 'id'")
        adapter = str(data.get("adapter") or "wrapper")
        if adapter not in ADAPTERS:
            log.warning("tool %r: unknown adapter %r, using 'wrapper'", tool_id, adapter)
            adapter = "wrapper"
        bindings: dict[str, str] = {}
        raw_bindings = data.get("bindings") or {}
        if isinstance(raw_bindings, dict):
            for key, value in raw_bindings.items():
                if isinstance(key, str) and isinstance(value, str) and key.strip():
                    bindings[key.strip()] = value
                else:
                    log.warning("tool %r: dropping bad binding %r", tool_id, key)
        else:
            log.warning("tool %r: 'bindings' must be an object, ignoring", tool_id)
        process = str(data.get("process") or "").strip()
        if not process:
            # Configs written before the process watcher existed carry no
            # `process` field — fall back to the well-known name for the id.
            process = DEFAULT_PROCESSES.get(tool_id, "")
        delivery = str(data.get("delivery") or "auto")
        if delivery not in ("auto", "tmux", "tty"):
            log.warning("tool %r: unknown delivery %r, using 'auto'", tool_id, delivery)
            delivery = "auto"
        return cls(
            id=tool_id,
            name=str(data.get("name") or tool_id),
            adapter=adapter,
            bindings=bindings,
            delivery_hint=str(data.get("delivery_hint") or ""),
            process=process,
            hidden=bool(data.get("hidden", False)),
            discover=bool(data.get("discover", True)),
            command=str(data.get("command") or "").strip(),
            delivery=delivery,
            aliases=[str(a) for a in data.get("aliases", []) if str(a).strip()],
        )

    def process_names(self) -> list[str]:
        """All process names matched by the presence watcher."""
        return [n for n in [self.process, *self.aliases] if n]


@dataclass
class ASRConfig:
    engine: str = "faster-whisper"
    model: str = "small"
    device: str = "cpu"
    language: str | None = None
    command: str = ""  # shell template for the "command" engine; wav path is appended

    def to_dict(self) -> dict:
        return {
            "engine": self.engine,
            "model": self.model,
            "device": self.device,
            "language": self.language,
            "command": self.command,
        }

    @classmethod
    def from_dict(cls, data: object) -> "ASRConfig":
        if data is None:
            return cls()
        if not isinstance(data, dict):
            log.warning("'asr' must be an object, using defaults")
            return cls()
        engine = str(data.get("engine") or "faster-whisper")
        if engine not in ASR_ENGINES:
            log.warning("unknown asr engine %r, using 'faster-whisper'", engine)
            engine = "faster-whisper"
        model = str(data.get("model") or "small")
        if model not in WHISPER_MODELS:
            log.warning("unknown whisper model %r, using 'small'", model)
            model = "small"
        language = data.get("language")
        if language is not None:
            language = str(language).strip() or None
            if language is not None and language.lower() in ("auto", "none", "null"):
                language = None  # UI writes "auto" for auto-detect; whisper wants None
        return cls(
            engine=engine,
            model=model,
            device=str(data.get("device") or "cpu"),
            language=language,
            command=str(data.get("command") or ""),
        )


@dataclass
class FeaturesConfig:
    """Daemon feature toggles (dashboard checkboxes)."""

    process_watcher: bool = True
    voice_enabled: bool = True

    def to_dict(self) -> dict:
        return {
            "process_watcher": self.process_watcher,
            "voice_enabled": self.voice_enabled,
        }

    @classmethod
    def from_dict(cls, data: object) -> "FeaturesConfig":
        if not isinstance(data, dict):
            return cls()
        return cls(
            process_watcher=bool(data.get("process_watcher", True)),
            voice_enabled=bool(data.get("voice_enabled", True)),
        )


@dataclass
class MicConfig:
    """Virtual microphone (PTT mic mode) settings."""

    enabled: bool = True

    def to_dict(self) -> dict:
        return {"enabled": self.enabled}

    @classmethod
    def from_dict(cls, data: object) -> "MicConfig":
        if not isinstance(data, dict):
            return cls()
        return cls(enabled=bool(data.get("enabled", True)))


@dataclass
class Config:
    tools: list[ToolConfig] = field(default_factory=list)
    asr: ASRConfig = field(default_factory=ASRConfig)
    features: FeaturesConfig = field(default_factory=FeaturesConfig)
    mic: MicConfig = field(default_factory=MicConfig)

    def to_dict(self) -> dict:
        return {
            "tools": [t.to_dict() for t in self.tools],
            "asr": self.asr.to_dict(),
            "features": self.features.to_dict(),
            "mic": self.mic.to_dict(),
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False, indent=2) + "\n"

    @classmethod
    def from_dict(cls, data: object) -> "Config":
        if not isinstance(data, dict):
            raise ConfigError("config must be a JSON object")
        raw_tools = data.get("tools", [])
        if not isinstance(raw_tools, list):
            raise ConfigError("'tools' must be a list")
        tools: list[ToolConfig] = []
        seen: set[str] = set()
        for entry in raw_tools:
            try:
                tool = ToolConfig.from_dict(entry)
            except ConfigError as exc:
                log.warning("dropping invalid tool entry: %s", exc)
                continue
            if tool.id in seen:
                log.warning("dropping duplicate tool id %r", tool.id)
                continue
            seen.add(tool.id)
            tools.append(tool)
        return cls(
            tools=tools,
            asr=ASRConfig.from_dict(data.get("asr")),
            features=FeaturesConfig.from_dict(data.get("features")),
            mic=MicConfig.from_dict(data.get("mic")),
        )

    @classmethod
    def from_json(cls, payload: str) -> "Config":
        return cls.from_dict(json.loads(payload))

    def tool_by_id(self, tool_id: str | None) -> ToolConfig | None:
        for tool in self.tools:
            if tool.id == tool_id:
                return tool
        return None


def default_config() -> Config:
    return Config(
        tools=[
            ToolConfig(
                id="claude-code",
                name="Claude Code",
                adapter="statusline",
                bindings={"enter": "Enter", "escape": "Escape"},
                delivery_hint="tmux pane recorded by the statusline adapter",
                process="claude",
                aliases=["claude-code"],
            ),
            ToolConfig(
                id="codex",
                name="Codex",
                adapter="wrapper",
                bindings={"ctrl-c": "C-c", "enter": "Enter", "escape": "Escape"},
                process="codex",
            ),
            ToolConfig(
                id="opencode",
                name="opencode",
                adapter="wrapper",
                bindings={"enter": "Enter", "escape": "Escape"},
                process="opencode",
            ),
            ToolConfig(
                id="kimi-cli",
                name="Kimi CLI",
                adapter="wrapper",
                bindings={"enter": "Enter", "escape": "Escape"},
                process="kimi",
                aliases=["kimi-cli", "kimi-code"],
            ),
        ],
        asr=ASRConfig(),
    )


def load(path: Path | str = DEFAULT_PATH) -> Config:
    """Load the config, creating the default file on first run.

    An unreadable or invalid file yields the defaults (logged), leaving
    the broken file untouched for the user to fix.
    """
    path = Path(path)
    if not path.exists():
        cfg = default_config()
        try:
            save(cfg, path)
            log.info("created default config at %s", path)
        except OSError as exc:
            log.warning("could not write default config to %s: %s", path, exc)
        return cfg
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        cfg = Config.from_dict(data)
    except (OSError, json.JSONDecodeError, ConfigError) as exc:
        log.warning("config %s unusable (%s); falling back to defaults", path, exc)
        return default_config()
    # Migration: the old default model "base" mangles Mandarin (traditional
    # gibberish); upgrade to "small". Explicit tiny/small choices survive.
    if cfg.asr.model == "base":
        cfg.asr.model = "small"
        try:
            save(cfg, path)
            log.info("migrated asr model base -> small in %s", path)
        except OSError as exc:
            log.warning("could not write migrated config: %s", exc)
    return cfg


def save(cfg: Config, path: Path | str = DEFAULT_PATH) -> None:
    """Write the config atomically (temp file + rename)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(cfg.to_json())
        os.replace(tmp, path)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def validate_json(payload: str) -> Config:
    """Strict parse for the setup UI: raises ConfigError on any problem."""
    try:
        data = json.loads(payload)
    except json.JSONDecodeError as exc:
        raise ConfigError(f"invalid JSON: {exc}") from exc
    cfg = Config.from_dict(data)
    if not cfg.tools:
        raise ConfigError("config must define at least one tool")
    if cfg.asr.engine == "command" and not cfg.asr.command.strip():
        raise ConfigError("asr engine 'command' requires a command template")
    return cfg
