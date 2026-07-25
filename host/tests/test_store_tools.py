import json
import time

import pytest

from vibestick.config import Config, ToolConfig
from vibestick.store import SessionStore


def write_session(dir_path, session_id, *, tool="claude-code", updated=None, **fields):
    data = {
        "id": session_id,
        "tool": tool,
        "session": f"name-{session_id}",
        "state": "running",
        "updated": updated if updated is not None else int(time.time()),
    }
    data.update(fields)
    (dir_path / f"{session_id}.json").write_text(json.dumps(data))
    return data


def make_config():
    return Config(
        tools=[
            ToolConfig(id="claude-code", name="Claude Code", adapter="statusline",
                       bindings={"enter": "Enter", "escape": "Escape"}),
            ToolConfig(id="codex", name="Codex", adapter="wrapper",
                       bindings={"ctrl-c": "C-c"}),
        ]
    )


@pytest.fixture
def store(tmp_path):
    s = SessionStore(tmp_path, config=make_config())
    write_session(tmp_path, "a1", tool="claude-code", session="fix-auth")
    write_session(tmp_path, "a2", tool="claude-code", session="other", state="waiting",
                  updated=int(time.time()) - 10)
    write_session(tmp_path, "c1", tool="codex", session="refactor", state="idle",
                  updated=int(time.time()) - 5)
    s.poll()
    return s


def test_default_selected_tool_is_first(store):
    assert store.selected_tool == "claude-code"
    assert store.active_id == "a1"  # most recent claude-code session


def test_sessions_payload_only_shows_selected_tool(store):
    payload = json.loads(store.sessions_payload())
    assert {e["id"] for e in payload["list"]} == {"a1", "a2"}
    assert payload["list"][payload["active"]]["id"] == "a1"


def test_tool_next_switches_and_resets_active(store):
    assert store.apply_command({"cmd": "tool.next"}) is True
    assert store.selected_tool == "codex"
    assert store.active_id == "c1"
    payload = json.loads(store.sessions_payload())
    assert [e["id"] for e in payload["list"]] == ["c1"]
    # Wraps around.
    store.apply_command({"cmd": "tool.next"})
    assert store.selected_tool == "claude-code"
    assert store.active_id == "a1"


def test_tool_select(store):
    assert store.apply_command({"cmd": "tool.select", "id": "codex"}) is True
    assert store.selected_tool == "codex"
    assert store.apply_command({"cmd": "tool.select", "id": "nope"}) is False
    assert store.selected_tool == "codex"


def test_session_commands_stay_within_selected_tool(store):
    assert store.apply_command({"cmd": "session.next"}) is True
    assert store.active_id == "a2"
    store.apply_command({"cmd": "session.next"})  # wraps within claude-code
    assert store.active_id == "a1"
    # Selecting a session of another tool is rejected.
    assert store.apply_command({"cmd": "session.select", "id": "c1"}) is False
    assert store.active_id == "a1"


def test_tools_payload_aggregate_state(store):
    payload = json.loads(store.tools_payload())
    assert payload["active"] == 0
    claude, codex = payload["list"]
    assert claude["id"] == "claude-code"
    assert claude["state"] == "running"  # a1 running wins over a2 waiting
    assert claude["fns"] == ["status", "sessions", "voice", "enter", "escape"]
    assert codex["state"] == "ready"
    assert codex["fns"] == ["status", "sessions", "voice", "ctrl-c"]

    store.apply_command({"cmd": "tool.next"})
    payload = json.loads(store.tools_payload())
    assert payload["active"] == 1


def test_tools_payload_tool_without_sessions_is_idle(store):
    store.apply_command({"cmd": "tool.select", "id": "codex"})
    (store.dir / "c1.json").unlink()
    store.poll()
    payload = json.loads(store.tools_payload())
    assert payload["list"][1]["state"] == "idle"
    assert json.loads(store.sessions_payload())["list"] == []
    status = json.loads(store.status_payload())
    assert status["state"] == "idle"
    assert status["tool"] == "codex"


def test_set_config_recovers_unknown_selection(store):
    cfg = Config(tools=[ToolConfig(id="codex", name="Codex")])
    assert store.set_config(cfg) is True
    assert store.selected_tool == "codex"
    assert store.active_id == "c1"


def test_v1_commands_still_work_with_config(store):
    assert store.apply_command({"cmd": "refresh"}) is False
    assert store.apply_command({"cmd": "bogus"}) is False
    assert store.selected_tool == "claude-code"
    assert store.active_id == "a1"
