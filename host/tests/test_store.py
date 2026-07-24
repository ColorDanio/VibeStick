import json
import time

import pytest

from vibestick.store import STALE_AFTER_SEC, SessionStore


def write_session(dir_path, session_id, *, updated=None, **fields):
    data = {
        "id": session_id,
        "tool": "claude-code",
        "model": "claude-opus-4",
        "session": f"name-{session_id}",
        "state": "running",
        "ctx_pct": -1,
        "cost_usd": -1,
        "last": "",
        "updated": updated if updated is not None else int(time.time()),
    }
    data.update(fields)
    (dir_path / f"{session_id}.json").write_text(json.dumps(data))
    return data


@pytest.fixture
def store(tmp_path):
    return SessionStore(tmp_path)


def test_poll_picks_up_new_files(store, tmp_path):
    assert store.poll() is False  # empty dir, no change
    write_session(tmp_path, "a1b2")
    assert store.poll() is True
    assert store.active_id == "a1b2"
    assert store.active().status.tool == "claude-code"


def test_poll_unchanged_after_first_read(store, tmp_path):
    write_session(tmp_path, "a1b2")
    store.poll()
    assert store.poll() is False  # mtime unchanged


def test_poll_detects_update(store, tmp_path):
    write_session(tmp_path, "a1b2", state="running")
    store.poll()
    data = write_session(tmp_path, "a1b2", state="waiting")
    # Force a different mtime in case the fs has coarse timestamps.
    import os

    p = tmp_path / "a1b2.json"
    os.utime(p, (p.stat().st_atime, p.stat().st_mtime + 2))
    assert store.poll() is True
    assert store.active().status.state == "waiting"
    assert data["state"] == "waiting"


def test_sessions_ordered_most_recent_first(store, tmp_path):
    now = int(time.time())
    write_session(tmp_path, "old", updated=now - 100)
    write_session(tmp_path, "new", updated=now)
    store.poll()
    assert [r.id for r in store.sessions()] == ["new", "old"]
    assert store.active_id == "new"


def test_status_and_sessions_payloads(store, tmp_path):
    write_session(tmp_path, "a1b2", tool="claude-code", session="fix-auth-bug")
    write_session(tmp_path, "c3d4", tool="codex", session="refactor-db", state="idle")
    store.poll()

    status = json.loads(store.status_payload())
    assert status["tool"] == "claude-code"
    sessions = json.loads(store.sessions_payload())
    assert set(sessions) == {"active", "list"}
    assert {e["id"] for e in sessions["list"]} == {"a1b2", "c3d4"}
    assert sessions["list"][sessions["active"]]["id"] == store.active_id


def test_empty_store_payloads(store):
    store.poll()
    status = json.loads(store.status_payload())
    assert status["state"] == "idle"
    sessions = json.loads(store.sessions_payload())
    assert sessions == {"active": 0, "list": []}


def test_command_next_prev_cycles(store, tmp_path):
    now = int(time.time())
    write_session(tmp_path, "s1", updated=now)
    write_session(tmp_path, "s2", updated=now - 1)
    write_session(tmp_path, "s3", updated=now - 2)
    store.poll()
    assert store.active_id == "s1"

    assert store.apply_command({"cmd": "session.next"}) is True
    assert store.active_id == "s2"
    store.apply_command({"cmd": "session.next"})
    assert store.active_id == "s3"
    store.apply_command({"cmd": "session.next"})  # wraps around
    assert store.active_id == "s1"
    store.apply_command({"cmd": "session.prev"})  # wraps backwards
    assert store.active_id == "s3"


def test_command_select(store, tmp_path):
    write_session(tmp_path, "a1b2")
    write_session(tmp_path, "c3d4")
    store.poll()
    assert store.apply_command({"cmd": "session.select", "id": "c3d4"}) is True
    assert store.active_id == "c3d4"
    # Unknown id: no change.
    assert store.apply_command({"cmd": "session.select", "id": "nope"}) is False
    assert store.active_id == "c3d4"


def test_command_refresh_is_noop(store, tmp_path):
    write_session(tmp_path, "a1b2")
    store.poll()
    assert store.apply_command({"cmd": "refresh"}) is False


def test_unknown_command_is_noop(store, tmp_path):
    write_session(tmp_path, "a1b2")
    store.poll()
    assert store.apply_command({"cmd": "bogus"}) is False
    assert store.active_id == "a1b2"


def test_stale_session_pruned(store, tmp_path):
    now = int(time.time())
    write_session(tmp_path, "stale", updated=now - STALE_AFTER_SEC - 60)
    write_session(tmp_path, "fresh", updated=now)
    store.poll()
    assert [r.id for r in store.sessions()] == ["fresh"]
    assert store.active_id == "fresh"


def test_deleted_file_removes_session(store, tmp_path):
    write_session(tmp_path, "a1b2")
    write_session(tmp_path, "c3d4")
    store.poll()
    (tmp_path / "a1b2.json").unlink()
    assert store.poll() is True
    assert [r.id for r in store.sessions()] == ["c3d4"]


def test_active_falls_back_when_active_session_gone(store, tmp_path):
    write_session(tmp_path, "a1b2")
    write_session(tmp_path, "c3d4")
    store.poll()
    store.apply_command({"cmd": "session.select", "id": "c3d4"})
    (tmp_path / "c3d4.json").unlink()
    store.poll()
    assert store.active_id == "a1b2"


def test_bad_json_file_ignored(store, tmp_path):
    (tmp_path / "broken.json").write_text("{not json")
    write_session(tmp_path, "good")
    assert store.poll() is True
    assert [r.id for r in store.sessions()] == ["good"]
