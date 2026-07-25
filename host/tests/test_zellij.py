import asyncio
from pathlib import Path
import json
import os
import subprocess
import sys

import pytest

from vibestick import delivery
from vibestick.delivery import (
    _binding_to_zellij_bytes,
    launch_zellij_pane,
    launch_tmux_session,
    resolve_target,
)


# -- resolve_target ------------------------------------------------------------


def test_resolve_order_tmux_zellij_tty():
    rec = {"tmux": "%1", "zellij": "main", "zellij_pane": "terminal_3",
           "tty": "/dev/pts/5"}
    assert resolve_target(rec) == ("tmux", "%1")  # tmux wins in auto
    assert resolve_target({"zellij": "main", "tty": "/dev/pts/5"}) == \
        ("zellij", ("main", ""))
    assert resolve_target({"tty": "/dev/pts/5"}) == ("tty", "/dev/pts/5")
    # zellij_pane carried through
    assert resolve_target({"zellij": "main", "zellij_pane": "terminal_3"}) == \
        ("zellij", ("main", "terminal_3"))
    # explicit modes
    assert resolve_target(rec, "zellij") == ("zellij", ("main", "terminal_3"))
    assert resolve_target(rec, "tty") == ("tty", "/dev/pts/5")
    assert resolve_target({"tty": "/dev/pts/5"}, "zellij") is None
    assert resolve_target({}) is None


# -- byte mapping ----------------------------------------------------------------


def test_binding_byte_mapping():
    assert _binding_to_zellij_bytes("enter") == [13]
    assert _binding_to_zellij_bytes("escape") == [27]
    assert _binding_to_zellij_bytes("ctrl-c") == [3]
    assert _binding_to_zellij_bytes("C-c") == [3]
    assert _binding_to_zellij_bytes("up") == [27, 91, 65]
    assert _binding_to_zellij_bytes("down") == [27, 91, 66]
    assert _binding_to_zellij_bytes("tab") == [9]
    assert _binding_to_zellij_bytes("backspace") == [127]
    assert _binding_to_zellij_bytes("f5") == [27, 91, 49, 53, 126]
    assert _binding_to_zellij_bytes("x") == [ord("x")]
    assert _binding_to_zellij_bytes("yes, continue") is None  # literal -> write-chars


# -- subprocess argv (mocked) -----------------------------------------------------


@pytest.fixture
def spawned(monkeypatch):
    calls = []

    class Proc:
        returncode = 0

        async def communicate(self):
            return (b"", b"")

    async def fake_exec(*argv, **kwargs):
        calls.append(argv)
        return Proc()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    return calls


def test_deliver_zellij_write_chars_then_enter(spawned):
    ok = asyncio.run(delivery.deliver_text(
        {"zellij": "work", "zellij_pane": "terminal_3"}, "hello"))
    assert ok is True
    assert spawned == [
        ("zellij", "--session", "work", "action", "write-chars", "hello", "-p", "terminal_3"),
        ("zellij", "--session", "work", "action", "write", "13", "-p", "terminal_3"),
    ]


def test_send_binding_zellij_bytes(spawned):
    ok = asyncio.run(delivery.send_binding({"zellij": "work"}, "escape"))
    assert ok is True
    assert spawned == [("zellij", "--session", "work", "action", "write", "27")]


def test_send_binding_zellij_literal_uses_write_chars(spawned):
    ok = asyncio.run(delivery.send_binding({"zellij": "work"}, ":q"))
    assert ok is True
    assert spawned == [("zellij", "--session", "work", "action", "write-chars", ":q")]


def test_send_binding_zellij_no_session(spawned):
    assert asyncio.run(delivery.send_binding({}, "escape")) is False
    assert spawned == []


def test_launch_zellij_pane_argv(spawned):
    ok = asyncio.run(launch_zellij_pane("work", "kimi-cli", "kimi chat --fast"))
    assert ok is True
    assert spawned == [("zellij", "--session", "work", "action", "new-pane",
                        "--", "kimi", "chat", "--fast")]
    assert asyncio.run(launch_zellij_pane("", "x", "kimi")) is False


def test_launch_standalone_tmux_session_uses_wrapper(spawned, monkeypatch):
    monkeypatch.setattr(delivery.time, "time", lambda: 1234)
    assert asyncio.run(launch_tmux_session("opencode", "opencode --model fast")) is True
    argv = spawned[0]
    assert argv[:8] == (
        "tmux", "new-session", "-d", "-s", "vibestick-opencode-1234", "-n", "opencode", "--"
    )
    assert argv[8:10] == ("bash", "-lc")
    assert "generic_wrapper.sh" in argv[10]
    assert argv[10].endswith("vibe_wrap opencode --model fast")
    assert asyncio.run(launch_tmux_session("", "opencode")) is False


def test_zellij_failure_returns_false(monkeypatch):
    class Proc:
        returncode = 1

        async def communicate(self):
            return (b"", b"no such session")

    async def fake_exec(*argv, **kwargs):
        return Proc()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    assert asyncio.run(delivery.deliver_text({"zellij": "gone"}, "hi")) is False


# -- adapters ---------------------------------------------------------------------


HOOK = os.path.realpath(
    Path(__file__).parent.parent / "adapters" / "kimi_hook.py")


def run_hook(home, payload, env_extra):
    env = dict(os.environ)
    env["HOME"] = str(home)
    env.pop("TMUX_PANE", None)
    env.pop("ZELLIJ", None)
    env.pop("ZELLIJ_SESSION_NAME", None)
    env.pop("ZELLIJ_PANE_ID", None)
    env.update(env_extra)
    return subprocess.run([sys.executable, HOOK], input=json.dumps(payload).encode(),
                          capture_output=True, env=env, timeout=15)


def test_kimi_hook_zellij_fields(tmp_path):
    env = {"ZELLIJ": "0", "ZELLIJ_SESSION_NAME": "work", "ZELLIJ_PANE_ID": "terminal_3"}
    run_hook(tmp_path, {"hook_event_name": "SessionStart", "session_id": "z1", "cwd": "/x"}, env)
    rec = json.loads((tmp_path / ".vibestick/sessions/z1.json").read_text())
    assert rec["zellij"] == "work"
    assert rec["zellij_pane"] == "terminal_3"


def test_kimi_hook_zellij_pane_id_optional(tmp_path):
    env = {"ZELLIJ": "0", "ZELLIJ_SESSION_NAME": "work"}  # no ZELLIJ_PANE_ID
    run_hook(tmp_path, {"hook_event_name": "SessionStart", "session_id": "z2", "cwd": "/x"}, env)
    rec = json.loads((tmp_path / ".vibestick/sessions/z2.json").read_text())
    assert rec["zellij"] == "work"
    assert "zellij_pane" not in rec


def test_kimi_hook_tmux_and_zellij_coexist(tmp_path):
    env = {"TMUX_PANE": "%2", "ZELLIJ": "0", "ZELLIJ_SESSION_NAME": "work"}
    run_hook(tmp_path, {"hook_event_name": "SessionStart", "session_id": "z3", "cwd": "/x"}, env)
    rec = json.loads((tmp_path / ".vibestick/sessions/z3.json").read_text())
    assert rec["tmux"] == "%2"
    assert rec["zellij"] == "work"
    # and tmux still wins at resolve time
    assert resolve_target(rec) == ("tmux", "%2")


def test_generic_wrapper_zellij(tmp_path):
    env = dict(os.environ)
    env["HOME"] = str(tmp_path)
    env["VIBESTICK_STATE_DIR"] = str(tmp_path / ".vibestick/sessions")
    env.pop("TMUX_PANE", None)
    env.update({"ZELLIJ": "0", "ZELLIJ_SESSION_NAME": "work", "ZELLIJ_PANE_ID": "3"})
    script = Path(__file__).parent.parent / "adapters" / "generic_wrapper.sh"
    subprocess.run(
        ["bash", "-c", f'. "{os.path.realpath(script)}" && vibe_wrap true'],
        env=env, capture_output=True, timeout=15)
    sessions = list((tmp_path / ".vibestick/sessions").glob("*.json"))
    assert sessions
    rec = json.loads(sessions[0].read_text())
    assert rec["zellij"] == "work"
    assert rec["zellij_pane"] == "3"


def test_statusline_adapter_zellij(tmp_path):
    env = dict(os.environ)
    env["HOME"] = str(tmp_path)
    env.pop("TMUX_PANE", None)
    env.update({"ZELLIJ": "0", "ZELLIJ_SESSION_NAME": "work", "ZELLIJ_PANE_ID": "terminal_1"})
    script = os.path.realpath(Path(__file__).parent.parent / "adapters" / "claude_code_statusline.py")
    subprocess.run([sys.executable, script], input=b'{"session_id": "cl1"}',
                   capture_output=True, env=env, timeout=15)
    rec = json.loads((tmp_path / ".vibestick/sessions/cl1.json").read_text())
    assert rec["zellij"] == "work"
    assert rec["zellij_pane"] == "terminal_1"
