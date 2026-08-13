import json
import os
import sqlite3
import time

from vibestick import protocol
from vibestick.config import Config, ToolConfig
from vibestick.discover import SessionDiscovery
from vibestick.protocol import SessionStatus
from vibestick.store import SessionStore

NOW = int(time.time())


def make_claude(root):
    proj = root / "claude" / "-home-u-myproj"
    proj.mkdir(parents=True)
    f = proj / "aaaa-1111.jsonl"
    f.write_text("\n".join([
        json.dumps({"type": "user", "cwd": "/home/u/myproj",
                    "message": {"role": "user", "content": [
                        {"type": "text", "text": "fix the auth redirect"}]}}),
        json.dumps({"type": "assistant", "message": {"role": "assistant", "content": [
            {"type": "text", "text": "Edited src/auth.ts"},
            {"type": "tool_use", "name": "Edit"}]}}),
        json.dumps({"type": "user", "message": {"role": "user", "content": [
            {"type": "tool_result", "content": "ok"}]}}),  # no text -> skipped
        json.dumps({"type": "assistant", "message": {"role": "assistant", "content": [
            {"type": "text", "text": "Running tests..."}]}}),
        "{broken",
    ]) + "\n")
    os.utime(f, (NOW, NOW))
    return f


def make_codex(root):
    d = root / "codex" / "2026" / "06" / "27"
    d.mkdir(parents=True)
    f = d / "rollout-2026-06-27T19-24-41-019f08d3-1e78-79d2-932a-3d95c817bc4a.jsonl"
    f.write_text("\n".join([
        json.dumps({"type": "session_meta", "payload": {
            "session_id": "019f08d3-1e78-79d2-932a-3d95c817bc4a", "cwd": "/home/u/eastcorp"}}),
        json.dumps({"type": "response_item", "payload": {"type": "message",
            "role": "user", "content": [{"type": "input_text",
            "text": "<environment_context> <cwd>/x</cwd> </environment_context>"}]}}),
        json.dumps({"type": "response_item", "payload": {"type": "message",
            "role": "user", "content": [{"type": "input_text", "text": "refactor the db layer"}]}}),
        json.dumps({"type": "response_item", "payload": {"type": "message",
            "role": "assistant", "content": [{"type": "output_text", "text": "Done, 3 files changed."}]}}),
        json.dumps({"type": "event_msg", "payload": {"type": "token_count",
            "info": {"total_token_usage": {"total_tokens": 120000}},
            "rate_limits": {"primary": {"used_percent": 12.0}}}}),
    ]) + "\n")
    os.utime(f, (NOW, NOW))
    return f


def make_kimi(root):
    d = root / "kimi" / "wd_proj_ab12" / "session_k1"
    (d / "agents" / "main").mkdir(parents=True)
    (d / "state.json").write_text(json.dumps({"title": "demo session"}))
    (d / "agents" / "main" / "wire.jsonl").write_text("\n".join([
        json.dumps({"type": "metadata", "protocol_version": "1.4"}),
        json.dumps({"type": "context.append_message", "message": {"role": "user",
            "content": [{"type": "text", "text": "<system-reminder>blob</system-reminder> injected"}]}}),
        json.dumps({"type": "context.append_message", "message": {"role": "user",
            "content": [{"type": "text", "text": "show the sessions"}]}}),
        json.dumps({"type": "context.append_message", "message": {"role": "assistant",
            "content": [{"type": "text", "text": "Here they are."}]}}),
        json.dumps({"type": "context.append_loop_event", "event": {}}),
    ]) + "\n")
    return d


def make_opencode(root):
    oc = root / "opencode"
    oc.mkdir(parents=True)
    db = sqlite3.connect(oc / "opencode.db")
    db.execute("CREATE TABLE session (id TEXT, title TEXT, directory TEXT,"
               " time_updated INTEGER, time_archived INTEGER, cost REAL)")
    db.execute("CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)")
    db.execute("CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT,"
               " time_created INTEGER, data TEXT)")
    db.execute("INSERT INTO session VALUES ('ses_1', 'demo', '/home/u/x', ?, NULL, 0.0)",
               (NOW * 1000,))
    db.execute("INSERT INTO message VALUES ('m1', 'ses_1', 1, ?)",
               (json.dumps({"role": "user"}),))
    db.execute("INSERT INTO message VALUES ('m2', 'ses_1', 2, ?)",
               (json.dumps({"role": "assistant"}),))
    db.execute("INSERT INTO part VALUES ('p1', 'm1', 'ses_1', 1, ?)",
               (json.dumps({"type": "text", "text": "set up AGENTS.md"}),))
    db.execute("INSERT INTO part VALUES ('p2', 'm2', 'ses_1', 2, ?)",
               (json.dumps({"type": "text", "text": "All done, tests pass."}),))
    db.execute("INSERT INTO part VALUES ('p3', 'm2', 'ses_1', 3, ?)",
               (json.dumps({"type": "step-finish"}),))
    db.commit()
    db.close()


def make_discovery(tmp_path):
    home = tmp_path / "root"
    for maker in (make_claude, make_codex, make_kimi, make_opencode):
        maker(home)
    return SessionDiscovery(roots={
        "claude-code": home / "claude", "codex": home / "codex",
        "kimi-cli": home / "kimi", "opencode": home / "opencode"})


def test_tail_claude(tmp_path):
    s = make_discovery(tmp_path).scan(["claude-code"])["claude-code"][0]
    assert s.tail == [
        "user: fix the auth redirect",
        "assistant: Edited src/auth.ts",
        "assistant: Running tests...",
    ]
    assert s.last == "Running tests..."


def test_tail_codex_filters_env_context(tmp_path):
    s = make_discovery(tmp_path).scan(["codex"])["codex"][0]
    assert s.tail == ["user: refactor the db layer", "assistant: Done, 3 files changed."]


def test_tail_kimi_wire_format(tmp_path):
    s = make_discovery(tmp_path).scan(["kimi-cli"])["kimi-cli"][0]
    assert s.tail == ["user: show the sessions", "assistant: Here they are."]


def test_tail_opencode_sqlite(tmp_path):
    s = make_discovery(tmp_path).scan(["opencode"])["opencode"][0]
    assert s.tail == ["user: set up AGENTS.md", "assistant: All done, tests pass."]


def test_tail_item_length_clipped(tmp_path):
    root = tmp_path / "root"
    proj = root / "claude" / "-home-u-x"
    proj.mkdir(parents=True)
    (proj / "s.jsonl").write_text(json.dumps({
        "type": "assistant", "message": {"role": "assistant", "content": [
            {"type": "text", "text": "x" * 500}]}}) + "\n")
    s = SessionDiscovery(roots={"claude-code": root / "claude"}).scan(["claude-code"])["claude-code"][0]
    assert len(s.tail) == 1
    assert len(s.tail[0]) <= len("assistant: ") + protocol.TAIL_ITEM_MAX_CHARS


def test_status_trimming_drops_oldest_tail_first():
    st = SessionStatus(
        tool="codex", model="m" * 100, session="s" * 100, state="running",
        ctx_pct=42, cost_usd=1.23, last="l" * 100, updated=NOW,
        tail=[f"user: entry{i} " + "x" * 60 for i in range(5)],
    )
    payload = st.to_json()
    assert len(payload.encode()) <= protocol.MAX_PAYLOAD
    d = json.loads(payload)
    # oldest entries dropped first: entry0 gone before entry4
    if "tail" in d:
        assert not any("entry0" in t for t in d["tail"])
        assert any("entry4" in t for t in d["tail"]) or d["last"] == ""
    assert d["tool"] == "codex" and d["state"] == "running"


def test_status_tail_round_trip_and_omitted_when_empty():
    st = SessionStatus(tool="codex", tail=["user: hi", "assistant: ok"])
    assert SessionStatus.from_json(st.to_json()).tail == ["user: hi", "assistant: ok"]
    empty = json.loads(SessionStatus(tool="codex").to_json())
    assert "tail" not in empty


# -- store/dashboard integration -----------------------------------------------


class StubDiscovery:
    def __init__(self, found):
        self.found = found

    def scan(self, tool_ids):
        return {t: self.found.get(t, []) for t in tool_ids}


def test_discovered_tail_in_status_payload(tmp_path):
    from vibestick.discover import DiscoveredSession

    stub = StubDiscovery({"codex": [DiscoveredSession(
        id="u1", tool="codex", name="eastcorp", updated=NOW,
        tail=["user: refactor db", "assistant: done"])]})
    cfg = Config(tools=[ToolConfig(id="codex", name="Codex", process="codex")])
    store = SessionStore(tmp_path / "sessions", config=cfg, discovery=stub)
    store.refresh_discovery()
    status = json.loads(store.status_payload())
    assert status["tail"] == ["user: refactor db", "assistant: done"]
    rec = store.sessions_for_tool("codex")[0]
    assert rec.status.tail == ["user: refactor db", "assistant: done"]


def test_adapter_tail_field_wins(tmp_path):
    cfg = Config(tools=[ToolConfig(id="codex", name="Codex")])
    store = SessionStore(tmp_path / "sessions", config=cfg)
    store.dir.mkdir()
    (tmp_path / "sessions" / "c1.json").write_text(json.dumps({
        "id": "c1", "tool": "codex", "session": "real", "state": "running",
        "updated": NOW, "tail": ["user: from adapter"]}))
    store.poll()
    status = json.loads(store.status_payload())
    assert status["tail"] == ["user: from adapter"]
