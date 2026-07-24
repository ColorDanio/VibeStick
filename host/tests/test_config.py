import json

import pytest

from vibestick import config as config_mod
from vibestick.config import ASRConfig, Config, ConfigError, ToolConfig


def test_load_creates_default_on_first_run(tmp_path):
    path = tmp_path / "sub" / "config.json"
    cfg = config_mod.load(path)
    assert path.exists()  # default file was written
    ids = [t.id for t in cfg.tools]
    assert ids == ["claude-code", "codex", "opencode", "kimi-cli"]
    adapters = {t.id: t.adapter for t in cfg.tools}
    assert adapters["claude-code"] == "statusline"
    assert adapters["codex"] == "wrapper"
    assert cfg.asr.engine == "faster-whisper"
    assert cfg.asr.model == "small"
    # File on disk parses back to the same config.
    assert config_mod.load(path).to_dict() == cfg.to_dict()


def test_default_bindings_and_fns(tmp_path):
    cfg = config_mod.load(tmp_path / "config.json")
    claude = cfg.tool_by_id("claude-code")
    assert claude.bindings == {"enter": "Enter", "escape": "Escape"}
    assert claude.fns() == ["status", "sessions", "voice", "enter", "escape"]
    codex = cfg.tool_by_id("codex")
    assert "ctrl-c" in codex.bindings
    assert codex.fns()[:3] == ["status", "sessions", "voice"]
    assert codex.fns()[3:] == sorted(codex.bindings)


def test_save_is_atomic_and_round_trips(tmp_path):
    path = tmp_path / "config.json"
    cfg = Config(
        tools=[ToolConfig(id="codex", name="Codex", bindings={"ctrl-c": "C-c"}, process="codex")],
        asr=ASRConfig(engine="command", command="my-asr --fast", language="en"),
    )
    config_mod.save(cfg, path)
    loaded = config_mod.load(path)
    assert loaded.to_dict() == cfg.to_dict()
    # No temp files left behind.
    assert [p.name for p in tmp_path.iterdir()] == ["config.json"]


def test_missing_process_falls_back_to_well_known_name(tmp_path):
    # Configs written before the process watcher existed carry no `process`.
    path = tmp_path / "config.json"
    path.write_text('{"tools": [{"id": "kimi-cli", "name": "Kimi CLI"}], "asr": {}}')
    cfg = config_mod.load(path)
    assert cfg.tool_by_id("kimi-cli").process == "kimi"


def test_load_bad_json_falls_back_without_overwriting(tmp_path):
    path = tmp_path / "config.json"
    path.write_text("{not json")
    cfg = config_mod.load(path)
    assert [t.id for t in cfg.tools] == ["claude-code", "codex", "opencode", "kimi-cli"]
    assert path.read_text() == "{not json"  # user's file untouched


def test_from_dict_drops_bad_entries(tmp_path):
    data = {
        "tools": [
            {"id": "codex", "name": "Codex", "adapter": "wrapper", "bindings": {"ctrl-c": "C-c"}},
            {"name": "no id"},  # dropped
            "garbage",  # dropped
            {"id": "codex"},  # duplicate id, dropped
            {"id": "weird", "adapter": "telepathy", "bindings": "oops"},  # coerced
        ],
        "asr": {"engine": "magic"},
    }
    cfg = Config.from_dict(data)
    assert [t.id for t in cfg.tools] == ["codex", "weird"]
    weird = cfg.tool_by_id("weird")
    assert weird.adapter == "wrapper"  # unknown adapter coerced
    assert weird.bindings == {}  # non-dict bindings ignored
    assert cfg.asr.engine == "faster-whisper"  # unknown engine coerced


def test_from_dict_rejects_non_object():
    with pytest.raises(ConfigError):
        Config.from_dict([1, 2, 3])
    with pytest.raises(ConfigError):
        Config.from_dict({"tools": "nope"})


def test_validate_json_strict():
    cfg = config_mod.validate_json(json.dumps({
        "tools": [{"id": "codex", "bindings": {"enter": "Enter"}}],
        "asr": {"engine": "command", "command": "transcribe"},
    }))
    assert cfg.asr.engine == "command"
    with pytest.raises(ConfigError):
        config_mod.validate_json("{nope")
    with pytest.raises(ConfigError):
        config_mod.validate_json(json.dumps({"tools": []}))
    with pytest.raises(ConfigError):
        config_mod.validate_json(json.dumps({
            "tools": [{"id": "x"}],
            "asr": {"engine": "command"},  # missing command template
        }))


def test_language_normalization():
    asr = ASRConfig.from_dict({"engine": "faster-whisper", "language": "  "})
    assert asr.language is None
    asr = ASRConfig.from_dict({"language": "en"})
    assert asr.language == "en"
