import importlib.util
import json
import os
import subprocess
import sys
import time

import pytest

HOOK = str(__import__("pathlib").Path(__file__).parent.parent / "vibestick" / ".." / "adapters" / "kimi_hook.py")
HOOK = os.path.realpath(HOOK)


def load_hook():
    spec = importlib.util.spec_from_file_location("kimi_hook", HOOK)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def run_hook(home, payload, env_extra=None):
    env = dict(os.environ)
    env["HOME"] = str(home)
    env.pop("TMUX_PANE", None)
    env.pop("TMUX", None)
    if env_extra:
        env.update(env_extra)
    return subprocess.run(
        [sys.executable, HOOK], input=json.dumps(payload).encode(),
        capture_output=True, env=env, timeout=15,
    )


def state_file(home, sid):
    return home / ".vibestick" / "sessions" / f"{sid}.json"


def test_record_has_pid_and_state(tmp_path):
    payload = {"hook_event_name": "SessionStart", "session_id": "s1", "cwd": "/home/u/proj"}
    res = run_hook(tmp_path, payload)
    assert res.returncode == 0, res.stderr
    rec = json.loads(state_file(tmp_path, "s1").read_text())
    assert rec["state"] == "running"
    assert rec["fg"] is True
    assert rec["pid"] == os.getpid()  # hook's parent == this pytest process
    # no controlling tty in this environment -> tty omitted
    assert "tty" not in rec


def test_tmux_pane_preferred_and_pid_present(tmp_path):
    payload = {"hook_event_name": "PreToolUse", "session_id": "s2", "cwd": "/x"}
    run_hook(tmp_path, payload, env_extra={"TMUX_PANE": "%9"})
    rec = json.loads(state_file(tmp_path, "s2").read_text())
    assert rec["tmux"] == "%9"
    assert rec["pid"] == os.getpid()


def test_prompt_written_to_last(tmp_path):
    payload = {"hook_event_name": "UserPromptSubmit", "session_id": "s3",
               "cwd": "/x", "prompt": "  fix the   auth flow  "}
    run_hook(tmp_path, payload)
    rec = json.loads(state_file(tmp_path, "s3").read_text())
    assert rec["last"] == "fix the auth flow"
    # a later heartbeat without a prompt preserves last
    run_hook(tmp_path, {"hook_event_name": "PreToolUse", "session_id": "s3", "cwd": "/x"})
    rec = json.loads(state_file(tmp_path, "s3").read_text())
    assert rec["last"] == "fix the auth flow"


def test_stop_then_session_end(tmp_path):
    run_hook(tmp_path, {"hook_event_name": "SessionStart", "session_id": "s4", "cwd": "/x"})
    run_hook(tmp_path, {"hook_event_name": "Stop", "session_id": "s4", "cwd": "/x"})
    rec = json.loads(state_file(tmp_path, "s4").read_text())
    assert rec["state"] == "waiting"
    run_hook(tmp_path, {"hook_event_name": "SessionEnd", "session_id": "s4", "cwd": "/x"})
    assert not state_file(tmp_path, "s4").exists()


def test_hook_log_ring(tmp_path):
    for i in range(60):
        run_hook(tmp_path, {"hook_event_name": "PreToolUse", "session_id": "s5", "cwd": "/x"})
    log = tmp_path / ".vibestick" / "hook-log.jsonl"
    lines = log.read_text().strip().splitlines()
    assert len(lines) == 50
    entry = json.loads(lines[-1])
    assert entry["event"] == "PreToolUse"
    assert entry["session_id"] == "s5"
    assert entry["result"] == "running written"
    assert "ts" in entry


# -- unit-level: pid/tty helpers ------------------------------------------------


def test_cli_pid_walks_past_shells(monkeypatch):
    hook = load_hook()
    monkeypatch.setattr(os, "getppid", lambda: 100)

    stats = {
        100: ("bash", 50),   # shell -> walk up
        50: ("kimi", 1),     # CLI -> stop
    }

    def fake_read(self):
        pid = int(self.parent.name)
        comm, ppid = stats[pid]
        if self.name == "comm":
            return comm
        return f"{pid} ({comm}) S {ppid} 1 1 0 0\n"

    monkeypatch.setattr(type(hook.Path("x")), "read_text", fake_read)
    assert hook.cli_pid() == 50


def test_tty_for_pid_real_pty():
    pytest.importorskip("pty")
    import pty
    import signal

    hook = load_hook()
    pid, fd = pty.fork()
    if pid == 0:  # child: controlling terminal is the pty slave
        os.execvp("sleep", ["sleep", "5"])
    try:
        tty = ""
        for _ in range(20):  # child's /proc stat may lag the fork slightly
            tty = hook.tty_for_pid(pid)
            if tty:
                break
            time.sleep(0.05)
        assert tty.startswith("/dev/pts/")
        # and it resolves to the same pty the child is on
        assert os.path.realpath(tty) == os.path.realpath(f"/proc/{pid}/fd/0")
    finally:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
        os.close(fd)


def test_tty_for_pid_no_terminal():
    hook = load_hook()
    assert hook.tty_for_pid(99999999) == ""  # gone
    # current pytest process has no controlling terminal in this environment
    assert hook.tty_for_pid(os.getpid()) == ""
