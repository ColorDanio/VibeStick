import json

from vibestick import protocol
from vibestick.protocol import SessionInfo, SessionsPayload, SessionStatus


def sample_status() -> SessionStatus:
    return SessionStatus(
        tool="claude-code",
        model="claude-opus-4",
        session="fix-auth-bug",
        state="running",
        ctx_pct=42,
        cost_usd=1.23,
        last="Edited src/auth.ts",
        updated=1721650000,
    )


def test_status_round_trip():
    s = sample_status()
    s2 = SessionStatus.from_json(s.to_json())
    assert s2 == s


def test_status_json_matches_protocol_doc():
    d = json.loads(sample_status().to_json())
    assert set(d) == {
        "tool", "model", "session", "state", "ctx_pct", "cost_usd", "last", "updated",
    }
    assert d["tool"] == "claude-code"
    assert d["state"] == "running"
    assert d["ctx_pct"] == 42
    assert d["cost_usd"] == 1.23
    assert d["updated"] == 1721650000


def test_status_from_dict_defaults_unknowns():
    s = SessionStatus.from_dict({"tool": "codex"})
    assert s.ctx_pct == -1
    assert s.cost_usd == -1.0
    assert s.state == "idle"
    assert s.model == ""


def test_status_last_truncated_to_80():
    s = sample_status()
    s.last = "x" * 200
    d = json.loads(s.to_json())
    assert len(d["last"]) <= 80
    assert d["last"].endswith("…")


def test_status_trimmed_to_512_bytes():
    s = sample_status()
    s.model = "m" * 400
    s.session = "s" * 400
    s.last = "l" * 400
    payload = s.to_json()
    assert len(payload.encode("utf-8")) <= protocol.MAX_PAYLOAD
    d = json.loads(payload)
    assert d["tool"] == "claude-code"  # required fields survive
    assert d["state"] == "running"


def test_sessions_round_trip():
    p = SessionsPayload(
        active=1,
        list=[
            SessionInfo(id="a1b2", tool="claude-code", name="fix-auth-bug", state="running"),
            SessionInfo(id="c3d4", tool="codex", name="refactor-db", state="idle"),
        ],
    )
    p2 = SessionsPayload.from_json(p.to_json())
    assert p2.active == 1
    assert [s.id for s in p2.list] == ["a1b2", "c3d4"]
    assert p2.list[0].tool == "claude-code"
    assert p2.list[1].state == "idle"


def test_sessions_json_matches_protocol_doc():
    p = SessionsPayload(
        active=0,
        list=[SessionInfo(id="a1b2", tool="claude-code", name="fix-auth-bug", state="running")],
    )
    d = json.loads(p.to_json())
    assert set(d) == {"active", "list"}
    assert set(d["list"][0]) == {"id", "tool", "name", "state", "fg"}


def test_sessions_trimmed_to_512_bytes_keeps_active():
    p = SessionsPayload(
        active=5,
        list=[
            SessionInfo(id=f"s{i}", tool="t" * 20, name="n" * 60, state="running")
            for i in range(30)
        ],
    )
    payload = p.to_json()
    assert len(payload.encode("utf-8")) <= protocol.MAX_PAYLOAD
    d = json.loads(payload)
    ids = [e["id"] for e in d["list"]]
    assert ids[d["active"]] == "s5"  # active entry survives trimming


def test_uuids_match_protocol_doc():
    assert protocol.SERVICE_UUID == "4b1e0001-5a3f-4c8d-9b6e-7f2a1c0d3e5f"
    assert protocol.STATUS_UUID == "4b1e0002-5a3f-4c8d-9b6e-7f2a1c0d3e5f"
    assert protocol.SESSIONS_UUID == "4b1e0003-5a3f-4c8d-9b6e-7f2a1c0d3e5f"
    assert protocol.INPUT_UUID == "4b1e0004-5a3f-4c8d-9b6e-7f2a1c0d3e5f"
    assert protocol.COMMAND_UUID == "4b1e0005-5a3f-4c8d-9b6e-7f2a1c0d3e5f"
