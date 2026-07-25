import importlib.metadata
import json
import os
import time

from vibestick import mic, voice
from vibestick.config import ASRConfig, Config, ToolConfig
from vibestick.discover import SessionDiscovery
from vibestick.mic import _apply_gain
from vibestick.store import SessionStore

NOW = int(time.time())


# -- ASR status detection -------------------------------------------------------


def test_asr_status_faster_whisper_installed():
    import pytest

    pytest.importorskip("faster_whisper", reason="asr extra not installed")
    st = voice.detect_asr_status(ASRConfig(engine="faster-whisper", device="cpu"))
    assert st["installed"] is True
    assert st["version"] is not None  # faster-whisper is installed in the venv
    assert st["peak_normalization"] is True
    assert st["cuda_devices"] == 0 or st["cuda_devices"] is None


def test_asr_status_cuda_unavailable_noted():
    st = voice.detect_asr_status(ASRConfig(engine="faster-whisper", device="cuda"))
    if st["installed"] and not st["cuda_devices"]:
        assert "no CUDA" in st["note"]


def test_asr_status_missing_package(monkeypatch):
    def no_version(name):
        raise importlib.metadata.PackageNotFoundError(name)

    monkeypatch.setattr(importlib.metadata, "version", no_version)
    st = voice.detect_asr_status(ASRConfig(engine="faster-whisper"))
    assert st["installed"] is False
    assert "vibestick[asr]" in st["note"]


def test_asr_status_command_engine():
    st = voice.detect_asr_status(ASRConfig(engine="command", command="my-asr"))
    assert st["installed"] is True
    st2 = voice.detect_asr_status(ASRConfig(engine="command", command=""))
    assert st2["installed"] is False


# -- procwatch aliases ------------------------------------------------------------


def test_aliases_parse_and_process_names():
    tool = ToolConfig.from_dict({"id": "kimi-cli", "process": "kimi",
                                 "aliases": ["kimi-cli", "kimi-code"]})
    assert tool.aliases == ["kimi-cli", "kimi-code"]
    assert tool.process_names() == ["kimi", "kimi-cli", "kimi-code"]
    d = tool.to_dict()
    assert d["aliases"] == ["kimi-cli", "kimi-code"]
    default = Config.from_dict({"tools": [{"id": "kimi-cli"}]}).tool_by_id("kimi-cli")
    assert "kimi" in default.process_names()  # DEFAULT_PROCESSES fallback


def test_presence_matches_alias(tmp_path):
    from vibestick.procwatch import ProcInfo

    class StubWatcher:
        def scan(self, names):
            # the process is alive under the ALIAS name, not the primary one
            assert "kimi-cli" in names and "kimi" in names
            return {"kimi-cli": ProcInfo(pid=1, name="kimi-cli", cwd="/x")}

    cfg = Config(tools=[ToolConfig(id="kimi-cli", name="Kimi CLI", process="kimi",
                                   aliases=["kimi-cli"])])
    store = SessionStore(tmp_path / "sessions", config=cfg, watcher=StubWatcher())
    assert store.refresh_presence() is True
    assert store.presence("kimi-cli") is not None
    tools = json.loads(store.tools_payload())
    assert tools["list"][0]["state"] == "ready"


def test_default_config_kimi_aliases():
    from vibestick.config import default_config

    kimi = default_config().tool_by_id("kimi-cli")
    assert kimi.process == "kimi"
    assert "kimi-cli" in kimi.aliases


# -- kimi wire.jsonl mtime drives activity -----------------------------------------


def test_kimi_discovery_uses_wire_mtime(tmp_path):
    root = tmp_path / "root" / "kimi"
    d = root / "wd_proj_ab12" / "session_k1"
    (d / "agents" / "main").mkdir(parents=True)
    state = d / "state.json"
    state.write_text(json.dumps({"title": "demo"}))
    old = NOW - 3600
    os.utime(state, (old, old))
    os.utime(d, (old, old))
    wire = d / "agents" / "main" / "wire.jsonl"
    wire.write_text(json.dumps({"type": "context.append_message", "message": {
        "role": "user", "content": [{"type": "text", "text": "hi"}]}}) + "\n")
    os.utime(wire, (NOW - 5, NOW - 5))  # hot now
    disc = SessionDiscovery(roots={"kimi-cli": root})
    s = disc.scan(["kimi-cli"])["kimi-cli"][0]
    assert abs(s.updated - (NOW - 5)) <= 2  # wire mtime, not stale state.json


# -- mic gain ----------------------------------------------------------------------


def test_apply_gain():
    assert _apply_gain(b"\x80", 1.0) == b"\x80"
    assert _apply_gain(bytes([128])) == bytes([128])  # silence center stays
    assert _apply_gain(bytes([188])) == bytes([255])  # clipped at 255
    assert _apply_gain(bytes([68])) == bytes([0])  # clipped at 0
    gained = _apply_gain(bytes([148]))
    assert gained == bytes([128 + (148 - 128) * 3])


def test_create_argv_gnome_visibility_props():
    argv = " ".join(mic.CREATE_ARGV)
    assert "Audio/Source/Virtual" in argv
    assert 'device.description="Vibe Mic"' in argv
    assert "device.class=sound" in argv
    assert "node.virtual=true" in argv
