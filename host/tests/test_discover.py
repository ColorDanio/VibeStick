import hashlib
import json
import os
import sqlite3
import time
from pathlib import Path

from vibestick.config import Config, ToolConfig
from vibestick.discover import MAX_SESSIONS_PER_TOOL, DiscoveredSession, SessionDiscovery
from vibestick.procwatch import ProcInfo
from vibestick.store import SessionStore


def sid(tool, stable):
    return "disc:" + hashlib.sha1(f"{tool}:{stable}".encode()).hexdigest()[:6]

NOW = int(time.time())


# -- Scanner fixtures ---------------------------------------------------------


def make_claude(root: Path):
    proj = root / "claude" / "-home-u-myproj"
    proj.mkdir(parents=True)
    f = proj / "416bf7bd-f1ec-4abf-a5be-912383fe7fcd.jsonl"
    f.write_text("\n".join([
        "not json at all",
        json.dumps({"type": "user", "cwd": "/home/u/myproj", "message": {"role": "user"}}),
        json.dumps({"type": "assistant", "message": {"role": "assistant", "content": [
            {"type": "text", "text": "First answer."}]}}),
        json.dumps({"type": "assistant", "message": {"role": "assistant", "content": [
            {"type": "tool_use", "name": "Edit"},
            {"type": "text", "text": "Edited   src/auth.ts\n done"}]}}),
    ]) + "\n")
    os.utime(f, (NOW - 60, NOW - 60))
    return f


def make_codex(root: Path):
    d = root / "codex" / "2026" / "06" / "27"
    d.mkdir(parents=True)
    f = d / "rollout-2026-06-27T19-24-41-019f08d3-1e78-79d2-932a-3d95c817bc4a.jsonl"
    f.write_text("\n".join([
        json.dumps({"type": "session_meta", "payload": {
            "session_id": "019f08d3-1e78-79d2-932a-3d95c817bc4a",
            "cwd": "/home/u/eastcorp"}}),
        "{broken",
        json.dumps({"type": "response_item", "payload": {"type": "message",
            "role": "assistant", "content": [{"type": "output_text", "text": "Refactored the db layer."}]}}),
        json.dumps({"type": "event_msg", "payload": {"type": "token_count"}}),
    ]) + "\n")
    os.utime(f, (NOW - 30, NOW - 30))
    return f


def make_kimi(root: Path):
    d = root / "kimi" / "wd_stick_cplus_7e41b599c5c0" / "session_8028811e-788a-43f2-baf2-72d5bedb5021"
    d.mkdir(parents=True)
    (d / "state.json").write_text(json.dumps({
        "title": "Build a vibe coding key", "updatedAt": "2026-07-22T22:46:22.569Z"}))
    os.utime(d / "state.json", (NOW - 10, NOW - 10))
    # Session without state.json: name falls back to the wd_<project> part.
    d2 = root / "kimi" / "wd_downloads_3d7d01f5ae07" / "session_1668596b-dd3b-42fb-99d8-fabcaef7cc77"
    d2.mkdir(parents=True)
    return d


def make_opencode(root: Path):
    oc = root / "opencode"
    oc.mkdir(parents=True)
    db = sqlite3.connect(oc / "opencode.db")
    db.execute(
        "CREATE TABLE session (id TEXT, title TEXT, directory TEXT,"
        " time_updated INTEGER, time_archived INTEGER, cost REAL)"
    )
    db.execute(
        "INSERT INTO session VALUES ('ses_abc123', 'Team status check',"
        " '/home/u/server', ?, NULL, 0.00625)", (NOW * 1000 - 5000,))
    db.execute(
        "INSERT INTO session VALUES ('ses_archived', 'old', '/x', 1000, 5, 0.0)")
    db.commit()
    db.close()


def make_discovery(tmp_path) -> SessionDiscovery:
    home = tmp_path / "root"
    for maker in (make_claude, make_codex, make_kimi, make_opencode):
        maker(home)
    return SessionDiscovery(roots={
        "claude-code": home / "claude",
        "codex": home / "codex",
        "kimi-cli": home / "kimi",
        "opencode": home / "opencode",
    })


def test_scan_claude(tmp_path):
    disc = make_discovery(tmp_path)
    sessions = disc.scan(["claude-code"])["claude-code"]
    assert len(sessions) == 1
    s = sessions[0]
    assert s.id == "416bf7bd-f1ec-4abf-a5be-912383fe7fcd"
    assert s.name == "myproj"
    assert s.last == "Edited src/auth.ts done"
    assert s.updated == NOW - 60
    assert s.cost_usd == -1.0


def test_scan_codex(tmp_path):
    disc = make_discovery(tmp_path)
    sessions = disc.scan(["codex"])["codex"]
    assert len(sessions) == 1
    s = sessions[0]
    assert s.id == "019f08d3-1e78-79d2-932a-3d95c817bc4a"
    assert s.name == "eastcorp"
    assert s.last == "Refactored the db layer."


def test_scan_kimi(tmp_path):
    disc = make_discovery(tmp_path)
    sessions = disc.scan(["kimi-cli"])["kimi-cli"]
    by_id = {s.id: s for s in sessions}
    assert by_id["session_8028811e-788a-43f2-baf2-72d5bedb5021"].name == "Build a vibe coding key"
    assert by_id["session_1668596b-dd3b-42fb-99d8-fabcaef7cc77"].name == "downloads"


def test_scan_opencode(tmp_path):
    disc = make_discovery(tmp_path)
    sessions = disc.scan(["opencode"])["opencode"]
    assert [s.id for s in sessions] == ["ses_abc123"]  # archived row excluded
    s = sessions[0]
    assert s.name == "Team status check"
    assert s.updated == NOW - 5
    assert abs(s.cost_usd - 0.00625) < 1e-9


def test_scan_caps_and_tolerates_weird_files(tmp_path):
    root = tmp_path / "root"
    proj = root / "claude" / "-home-u-x"
    proj.mkdir(parents=True)
    for i in range(MAX_SESSIONS_PER_TOOL * 3):
        f = proj / f"{i:040d}.jsonl"
        f.write_text("garbage\n")  # unparseable: skipped, no crash
        os.utime(f, (NOW - i, NOW - i))
    disc = SessionDiscovery(roots={"claude-code": root / "claude"})
    sessions = disc.scan(["claude-code"])["claude-code"]
    assert len(sessions) == MAX_SESSIONS_PER_TOOL
    assert [s.updated for s in sessions] == sorted(
        [s.updated for s in sessions], reverse=True)


def test_scan_missing_roots(tmp_path):
    disc = SessionDiscovery(roots={"codex": tmp_path / "nope"})
    assert disc.scan(["codex"]) == {"codex": []}
    assert disc.scan(["unknown-tool"]) == {}


def test_meta_cache_uses_mtime_shortcut(tmp_path):
    disc = make_discovery(tmp_path)
    first = disc.scan(["claude-code"])["claude-code"][0]
    # Same mtime: cached parse reused even though content changed.
    f = tmp_path / "root" / "claude" / "-home-u-myproj" / "416bf7bd-f1ec-4abf-a5be-912383fe7fcd.jsonl"
    f.write_text(json.dumps({"cwd": "/elsewhere"}) + "\n")
    os.utime(f, (first.updated, first.updated))
    again = disc.scan(["claude-code"])["claude-code"][0]
    assert again.name == "myproj"


# -- Store integration ----------------------------------------------------------


class StubWatcher:
    def __init__(self, found=None):
        self.found = found or {}

    def scan(self, names):
        return dict(self.found)


class StubDiscovery:
    def __init__(self, found):
        self.found = found
        self.calls = []

    def scan(self, tool_ids):
        self.calls.append(list(tool_ids))
        return {t: self.found.get(t, []) for t in tool_ids}


def disc_session(sid, tool, name, updated, last="", cost=-1.0):
    return DiscoveredSession(id=sid, tool=tool, name=name, last=last,
                             updated=updated, cost_usd=cost)


def make_store(tmp_path, discovery, watcher=None, discover=True):
    cfg = Config(tools=[ToolConfig(id="codex", name="Codex", process="codex",
                                   discover=discover)])
    return SessionStore(tmp_path / "sessions", config=cfg, watcher=watcher,
                        discovery=discovery)


def test_discovered_sessions_in_payloads(tmp_path):
    stub = StubDiscovery({"codex": [
        disc_session("u1", "codex", "eastcorp", NOW - 100, last="Did a refactor"),
        disc_session("u2", "codex", "vortex", NOW - 5000),
    ]})
    store = make_store(tmp_path, stub)
    store.poll()
    assert store.refresh_discovery() is True

    sessions = json.loads(store.sessions_payload())
    assert [e["id"] for e in sessions["list"]] == [sid("codex", "u1"), sid("codex", "u2")]
    assert all(len(e["id"]) <= 11 for e in sessions["list"])  # firmware id buffer
    assert sessions["list"][0] == {
        "id": sid("codex", "u1"), "tool": "codex", "name": "eastcorp", "state": "idle", "fg": False}

    status = json.loads(store.status_payload())
    assert status["session"] == "eastcorp"
    assert status["last"] == "Did a refactor"
    assert status["state"] == "idle"  # no live process -> not running
    assert status["updated"] == NOW - 100

    # Selectable like any session.
    assert store.apply_command({"cmd": "session.select", "id": sid("codex", "u2")}) is True
    assert json.loads(store.status_payload())["session"] == "vortex"


def test_discovered_running_only_with_live_process_and_recent(tmp_path):
    stub = StubDiscovery({"codex": [
        disc_session("recent", "codex", "a", NOW - 5),
        disc_session("open", "codex", "c", NOW - 120),
        disc_session("old", "codex", "b", NOW - 3600),
    ]})
    watcher = StubWatcher({"codex": ProcInfo(pid=1, name="codex", cwd="/x")})
    store = make_store(tmp_path, stub, watcher=watcher)
    store.refresh_presence()
    store.refresh_discovery()
    sessions = json.loads(store.sessions_payload())
    states = {e["id"]: e["state"] for e in sessions["list"]}
    assert states[sid("codex", "recent")] == "running"  # inferring now + live process
    assert states[sid("codex", "open")] == "idle"  # open but quiet >20s => not inferring
    assert states[sid("codex", "old")] == "idle"  # stale mtime

    # Process exits: running reverts to idle on next discovery refresh.
    watcher.found = {}
    store.refresh_presence()
    store.refresh_discovery()
    sessions = json.loads(store.sessions_payload())
    assert all(e["state"] == "idle" for e in sessions["list"])


def test_adapter_files_beat_discovered_no_duplicates(tmp_path):
    stub = StubDiscovery({"codex": [disc_session("u1", "codex", "eastcorp", NOW)]})
    watcher = StubWatcher({"codex": ProcInfo(pid=1, name="codex", cwd="/x")})
    store = make_store(tmp_path, stub, watcher=watcher)
    store.dir.mkdir()
    store.refresh_presence()
    store.refresh_discovery()
    # The live process stays first so it is selectable; the discovered
    # transcript remains available immediately after it.
    assert [e["id"] for e in json.loads(store.sessions_payload())["list"]] == [
        "proc:1", sid("codex", "u1")
    ]

    (tmp_path / "sessions" / "c1.json").write_text(json.dumps({
        "id": "c1", "tool": "codex", "session": "real", "state": "running",
        "updated": NOW}))
    store.poll()
    sessions = json.loads(store.sessions_payload())
    assert [e["id"] for e in sessions["list"]] == ["c1"]  # no discovered duplicate
    assert json.loads(store.status_payload())["session"] == "real"


def test_live_presence_is_prepended_to_discovered_sessions(tmp_path):
    stub = StubDiscovery({"codex": [disc_session("u1", "codex", "eastcorp", NOW)]})
    watcher = StubWatcher({"codex": ProcInfo(pid=1, name="codex", cwd="/x")})
    store = make_store(tmp_path, stub, watcher=watcher)
    store.refresh_presence()
    store.refresh_discovery()
    ids = [e["id"] for e in json.loads(store.sessions_payload())["list"]]
    assert ids == ["proc:1", sid("codex", "u1")]
    assert store.presence("codex") is not None


def test_discover_disabled_per_tool(tmp_path):
    stub = StubDiscovery({"codex": [disc_session("u1", "codex", "x", NOW)]})
    store = make_store(tmp_path, stub, discover=False)
    assert store.refresh_discovery() is False
    assert stub.calls[-1] == []  # codex excluded from the scan
    assert json.loads(store.sessions_payload())["list"] == []


def test_tools_payload_uses_discovered_state(tmp_path):
    stub = StubDiscovery({"codex": [disc_session("u1", "codex", "a", NOW - 10)]})
    watcher = StubWatcher({"codex": ProcInfo(pid=1, name="codex", cwd="/x")})
    store = make_store(tmp_path, stub, watcher=watcher)
    store.refresh_presence()
    store.refresh_discovery()
    tools = json.loads(store.tools_payload())
    assert tools["list"][0]["state"] == "running"


def test_tools_payload_presence_marks_idle_discovered_as_ready(tmp_path):
    # A live process must not force "running" when discovery reports the
    # session as idle (open but quiet) — precedence adapter > discovered >
    # presence applies to the inference state; the tool picker exposes a
    # selectable idle session as ready.
    stub = StubDiscovery({"codex": [disc_session("u1", "codex", "a", NOW - 120)]})
    watcher = StubWatcher({"codex": ProcInfo(pid=1, name="codex", cwd="/x")})
    store = make_store(tmp_path, stub, watcher=watcher)
    store.refresh_presence()
    store.refresh_discovery()
    tools = json.loads(store.tools_payload())
    assert tools["list"][0]["state"] == "ready"


def test_adapter_record_absorbs_discovered_tail(tmp_path):
    # kimi case: adapter file (live state, no tail) + discovery (tail from
    # the CLI's own transcript) with the same session id — the adapter
    # record shows the tail on the device.
    from vibestick.discover import DiscoveredSession

    cfg = Config(tools=[ToolConfig(id="kimi-cli", name="Kimi", process="kimi")])
    stub = StubDiscovery({"kimi-cli": [
        DiscoveredSession(id="session_abc", tool="kimi-cli", name="proj",
                          last="assistant: done", updated=NOW, cost_usd=-1.0,
                          tail=["user: 改一下按钮", "assistant: done"]),
    ]})
    store = SessionStore(tmp_path / "sessions", config=cfg, discovery=stub)
    store.dir.mkdir(parents=True)
    (tmp_path / "sessions" / "session_abc.json").write_text(json.dumps({
        "id": "session_abc", "tool": "kimi-cli", "session": "proj",
        "state": "waiting", "updated": NOW, "fg": True}))
    store.poll()
    store.refresh_discovery()

    sessions = json.loads(store.sessions_payload())
    assert [e["id"] for e in sessions["list"]] == ["session_abc"]  # no duplicate
    status = json.loads(store.status_payload())
    assert status["state"] == "waiting"  # adapter state wins
    assert status["tail"] == ["user: 改一下按钮", "assistant: done"]
