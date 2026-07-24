import asyncio
import json
import os
import time

import pytest

from vibestick import delivery
from vibestick.procwatch import is_foreground, read_proc_stat, tty_path_for

NOW = int(time.time())
PTS_NR = (136 << 8) | 5  # /dev/pts/5


def make_stat(proc_root, pid, *, comm="codex", state="S", ppid=1, pgrp=None,
              tty_nr=0, tpgid=0):
    pgrp = pgrp if pgrp is not None else pid
    d = proc_root / str(pid)
    d.mkdir(parents=True, exist_ok=True)
    (d / "stat").write_text(
        f"{pid} ({comm}) {state} {ppid} {pgrp} {pgrp} {tty_nr} {tpgid} 0 0 0 0 0\n"
    )


def test_read_proc_stat_parses_fields(tmp_path):
    make_stat(tmp_path, 100, ppid=42, tty_nr=PTS_NR, tpgid=100)
    stat = read_proc_stat(100, tmp_path)
    assert stat.ppid == 42
    assert stat.pgrp == 100
    assert stat.tty_nr == PTS_NR
    assert stat.tpgid == 100
    assert read_proc_stat(999, tmp_path) is None


def test_tty_path_for_pts_only():
    assert tty_path_for(PTS_NR) == "/dev/pts/5"
    assert tty_path_for(0) is None
    assert tty_path_for((4 << 8) | 1) is None  # /dev/tty1, not a pts


def test_is_foreground_self_and_ancestor(tmp_path):
    # CLI itself is the foreground pgroup leader.
    make_stat(tmp_path, 100, ppid=50, tty_nr=PTS_NR, tpgid=100)
    make_stat(tmp_path, 50, comm="bash", ppid=1, pgrp=50, tty_nr=PTS_NR, tpgid=100)
    assert is_foreground(read_proc_stat(100, tmp_path), tmp_path) is True

    # CLI in background, but an ancestor (e.g. tmux pane shell) is foreground.
    make_stat(tmp_path, 200, ppid=150, pgrp=200, tty_nr=PTS_NR, tpgid=150)
    make_stat(tmp_path, 150, comm="bash", ppid=1, pgrp=150, tty_nr=PTS_NR, tpgid=150)
    assert is_foreground(read_proc_stat(200, tmp_path), tmp_path) is True

    # Background job: nobody in the chain is the foreground group.
    make_stat(tmp_path, 300, ppid=50, pgrp=300, tty_nr=PTS_NR, tpgid=999)
    assert is_foreground(read_proc_stat(300, tmp_path), tmp_path) is False

    # No controlling terminal at all.
    make_stat(tmp_path, 400, tty_nr=0, tpgid=0)
    assert is_foreground(read_proc_stat(400, tmp_path), tmp_path) is False


def test_resolve_target_modes():
    rec = {"tmux": "%1", "tty": "/dev/pts/5"}
    assert delivery.resolve_target(rec) == ("tmux", "%1")  # auto prefers tmux
    assert delivery.resolve_target(rec, "tty") == ("tty", "/dev/pts/5")
    assert delivery.resolve_target(rec, "tmux") == ("tmux", "%1")
    assert delivery.resolve_target({"tty": "/dev/pts/5"}) == ("tty", "/dev/pts/5")
    assert delivery.resolve_target({"tmux": "%1"}, "tty") is None
    assert delivery.resolve_target({}) is None
    assert delivery.resolve_target(None) is None


@pytest.fixture
def fake_pts(tmp_path, monkeypatch):
    """Fake /proc + fake pts tree; returns (proc_root, pts_file)."""
    proc_root = tmp_path / "proc"
    proc_root.mkdir()
    pts = tmp_path / "pts" / "5"
    pts.parent.mkdir()
    pts.touch()
    monkeypatch.setattr(delivery, "_PROC_ROOT", str(proc_root))
    monkeypatch.setattr(delivery, "_DEVPTS", str(tmp_path / "pts"))
    return proc_root, pts


def test_tty_gate_and_message_delivery(fake_pts):
    proc_root, pts = fake_pts
    make_stat(proc_root, 100, ppid=1, pgrp=100, tty_nr=PTS_NR, tpgid=100)
    ok = asyncio.run(delivery.deliver_text(
        {"tty": str(pts), "pid": 100}, "hello stick"))
    assert ok is True
    assert pts.read_bytes() == b"hello stick\r"


def test_tty_gate_rejects_gone_or_background(fake_pts, tmp_path):
    proc_root, pts = fake_pts
    # Process gone.
    assert delivery.tty_gate_ok(999, str(pts)) is False
    assert asyncio.run(delivery.deliver_text({"tty": str(pts), "pid": 999}, "x")) is False
    # Alive but background (tpgid is another group).
    make_stat(proc_root, 300, ppid=1, pgrp=300, tty_nr=PTS_NR, tpgid=50)
    assert asyncio.run(delivery.deliver_text({"tty": str(pts), "pid": 300}, "x")) is False
    assert pts.read_bytes() == b""
    # Alive, foreground, but controlling terminal moved elsewhere.
    (tmp_path / "pts" / "9").touch()
    make_stat(proc_root, 400, ppid=1, pgrp=400, tty_nr=(136 << 8) | 9, tpgid=400)
    assert asyncio.run(delivery.deliver_text({"tty": str(pts), "pid": 400}, "x")) is False


def test_tty_cancel_binding_delivery(fake_pts):
    proc_root, pts = fake_pts
    make_stat(proc_root, 100, ppid=1, pgrp=100, tty_nr=PTS_NR, tpgid=100)
    ok = asyncio.run(delivery.send_binding({"tty": str(pts), "pid": 100}, "escape"))
    assert ok is True
    assert pts.read_bytes() == b"\x1b"


def test_tty_delivery_mode_restricts(fake_pts):
    proc_root, pts = fake_pts
    make_stat(proc_root, 100, ppid=1, pgrp=100, tty_nr=PTS_NR, tpgid=100)
    rec = {"tmux": "%1", "tty": str(pts), "pid": 100}
    # mode=tmux with tmux present would spawn tmux; mode=tty forces the pts.
    ok = asyncio.run(delivery.deliver_text(rec, "forced", mode="tty"))
    assert ok is True
    assert pts.read_bytes() == b"forced\r"


# -- session.select regression (bug 1) -----------------------------------------

import hashlib

from vibestick.config import Config, ToolConfig
from vibestick.discover import DiscoveredSession
from vibestick.store import SessionStore


class StubDiscovery:
    def __init__(self, found):
        self.found = found

    def scan(self, tool_ids):
        return {t: self.found.get(t, []) for t in tool_ids}


def sid(tool, stable):
    return "disc:" + hashlib.sha1(f"{tool}:{stable}".encode()).hexdigest()[:6]


def make_disc_store(tmp_path):
    cfg = Config(tools=[ToolConfig(id="kimi-cli", name="Kimi CLI", process="kimi")])
    stub = StubDiscovery({"kimi-cli": [
        DiscoveredSession(id="session_aaa", tool="kimi-cli", name="proj-a", updated=NOW),
        DiscoveredSession(id="session_bbb", tool="kimi-cli", name="proj-b", updated=NOW - 100),
    ]})
    store = SessionStore(tmp_path / "sessions", config=cfg, discovery=stub)
    store.poll()
    store.refresh_discovery()
    return store


def test_discovered_sessions_are_selectable(tmp_path):
    store = make_disc_store(tmp_path)
    payload = json.loads(store.sessions_payload())
    ids = [e["id"] for e in payload["list"]]
    assert ids == [sid("kimi-cli", "session_aaa"), sid("kimi-cli", "session_bbb")]
    assert all(len(i) <= 11 for i in ids)  # fits the firmware id buffer

    assert store.apply_command({"cmd": "session.select", "id": ids[1]}) is True
    assert store.active_id == ids[1]
    sessions = json.loads(store.sessions_payload())
    assert sessions["list"][sessions["active"]]["id"] == ids[1]
    assert json.loads(store.status_payload())["session"] == "proj-b"


def test_select_truncated_id_unique_prefix(tmp_path):
    store = make_disc_store(tmp_path)
    ids = [e["id"] for e in json.loads(store.sessions_payload())["list"]]
    # Simulate firmware truncation (id[12] on-device).
    truncated = ids[1][:11]
    assert truncated == ids[1]  # new ids survive truncation entirely
    # A genuinely truncated adapter-style id still resolves by unique prefix.
    write = tmp_path / "sessions" / "416bf7bd-f1ec-4abf.json"
    write.parent.mkdir(exist_ok=True)
    write.write_text(json.dumps({
        "id": "416bf7bd-f1ec-4abf-a5be-912383fe7fcd", "tool": "kimi-cli",
        "session": "real", "state": "running", "updated": NOW}))
    store.poll()
    assert store.apply_command(
        {"cmd": "session.select", "id": "416bf7bd-f1"}) is True  # 11 chars
    assert store.active_id == "416bf7bd-f1ec-4abf-a5be-912383fe7fcd"
    # Ambiguous prefix is rejected.
    assert store.apply_command({"cmd": "session.select", "id": "disc:"}) is False
    assert store.apply_command({"cmd": "session.select", "id": "nope"}) is False
