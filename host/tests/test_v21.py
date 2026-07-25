import asyncio
import json
import os
import time
from pathlib import Path

from fakes import FakeTransport

from vibestick import daemon, delivery
from vibestick.config import Config, ToolConfig
from vibestick.procwatch import ProcInfo
from vibestick.store import SessionStore

NOW = int(time.time())


def write_session(dir_path, session_id, *, tool="codex", mtime=None, **fields):
    data = {
        "id": session_id, "tool": tool, "session": f"name-{session_id}",
        "state": "running", "updated": int(mtime or time.time()),
    }
    data.update(fields)
    path = dir_path / f"{session_id}.json"
    path.write_text(json.dumps(data))
    if mtime:
        os.utime(path, (mtime, mtime))
    return data


class StubWatcher:
    def __init__(self, found=None):
        self.found = found or {}

    def scan(self, names):
        return dict(self.found)


def make_store(tmp_path, watcher=None, **tool_kwargs):
    cfg = Config(tools=[ToolConfig(id="codex", name="Codex", process="codex",
                                   **tool_kwargs)])
    store = SessionStore(tmp_path / "sessions", config=cfg, watcher=watcher)
    store.dir.mkdir()
    return store


# -- fg marking ----------------------------------------------------------------


def test_fg_adapter_reported(tmp_path):
    store = make_store(tmp_path)  # no watcher: heuristic would say False
    write_session(tmp_path / "sessions", "c1", fg=True)
    store.poll()
    entry = json.loads(store.sessions_payload())["list"][0]
    assert entry["fg"] is True


def test_fg_heuristic_recent_mtime_plus_live_process(tmp_path):
    watcher = StubWatcher({"codex": ProcInfo(pid=1, name="codex", cwd="/x")})
    store = make_store(tmp_path, watcher=watcher)
    write_session(tmp_path / "sessions", "c1")
    store.poll()
    store.refresh_presence()
    entry = json.loads(store.sessions_payload())["list"][0]
    assert entry["fg"] is True


def test_fg_false_without_process_or_when_stale(tmp_path):
    watcher = StubWatcher()
    store = make_store(tmp_path, watcher=watcher)
    write_session(tmp_path / "sessions", "c1")
    write_session(tmp_path / "sessions", "c2", mtime=time.time() - 600)
    store.poll()
    store.refresh_presence()
    entries = {e["id"]: e for e in json.loads(store.sessions_payload())["list"]}
    assert entries["c1"]["fg"] is False  # no live process
    assert entries["c2"]["fg"] is False  # stale mtime

    # Process appears: only the fresh session gets fg.
    watcher.found = {"codex": ProcInfo(pid=1, name="codex", cwd="/x")}
    store.refresh_presence()
    entries = {e["id"]: e for e in json.loads(store.sessions_payload())["list"]}
    assert entries["c1"]["fg"] is True
    assert entries["c2"]["fg"] is False


def test_cancel_binding_not_a_device_fn_and_launch_command():
    tool = ToolConfig(id="codex", name="Codex", process="codex",
                      bindings={"cancel": "C-c", "enter": "Enter"})
    assert tool.fns() == ["status", "sessions", "voice", "enter"]
    assert tool.launch_command() == "codex"  # falls back to process name
    tool2 = ToolConfig(id="codex", name="Codex", process="codex", command="codex --full-auto")
    assert tool2.launch_command() == "codex --full-auto"


# -- daemon command routing (e2e with fake transport) ---------------------------


def run_daemon_briefly(store, transport, body):
    async def main():
        task = asyncio.ensure_future(daemon.run_daemon(
            store, transport, store.config,
            poll_interval=0.05, presence_interval=0.05, discovery_interval=0.05))
        await asyncio.sleep(0.2)
        await body()
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    asyncio.run(main())


def test_inference_cancel_sends_escape_by_default(tmp_path, monkeypatch):
    store = make_store(tmp_path)
    write_session(tmp_path / "sessions", "c1", tmux="%1")
    store.poll()
    calls = []

    async def fake_send_binding(record, binding, mode="auto"):
        calls.append((record, binding))
        return True

    monkeypatch.setattr(delivery, "send_binding", fake_send_binding)
    transport = FakeTransport()

    async def body():
        transport.notify("COMMAND", b'{"cmd":"inference.cancel"}')
        await asyncio.sleep(0.1)

    run_daemon_briefly(store, transport, body)
    assert len(calls) == 1
    assert calls[0][0]["tmux"] == "%1"
    assert calls[0][1] == "escape"


def test_inference_cancel_uses_cancel_binding_override(tmp_path, monkeypatch):
    store = make_store(tmp_path, bindings={"cancel": "C-c"})
    write_session(tmp_path / "sessions", "c1", tmux="%1")
    store.poll()
    calls = []

    async def fake_send_binding(record, binding, mode="auto"):
        calls.append(binding)
        return True

    monkeypatch.setattr(delivery, "send_binding", fake_send_binding)
    transport = FakeTransport()

    async def body():
        transport.notify("COMMAND", b'{"cmd":"inference.cancel"}')
        await asyncio.sleep(0.1)

    run_daemon_briefly(store, transport, body)
    assert calls == ["C-c"]


def test_inference_cancel_without_delivery_target_reports_error(tmp_path):
    store = make_store(tmp_path)  # real delivery; session has no tmux/tty
    write_session(tmp_path / "sessions", "c1")
    store.poll()
    transport = FakeTransport()

    async def body():
        transport.notify("COMMAND", b'{"cmd":"inference.cancel"}')
        await asyncio.sleep(0.2)

    run_daemon_briefly(store, transport, body)
    status = json.loads(transport.last("STATUS"))
    assert status["state"] == "error"
    assert "delivery" in status["last"]


def test_session_new_starts_standalone_tmux_without_anchor(tmp_path, monkeypatch):
    store = make_store(tmp_path)  # no sessions, no tmux anchor
    store.poll()
    calls = []

    async def fake_launch(tool_id, name, command, cwd):
        calls.append((tool_id, name, command, cwd))
        return True

    monkeypatch.setattr(delivery, "launch_tmux_session", fake_launch)
    transport = FakeTransport()

    async def body():
        transport.notify("COMMAND", b'{"cmd":"session.new"}')
        await asyncio.sleep(0.2)

    run_daemon_briefly(store, transport, body)
    assert calls == [("codex", "codex", "codex", str(Path.home()))]


def test_session_new_ignores_stale_selected_record(tmp_path):
    store = make_store(tmp_path)
    store.poll()
    store.active_id = "proc:gone"
    assert store.tmux_target_for_selected() is None
    assert store.zellij_target_for_selected() is None


def test_session_new_launches_window_and_selects_session(tmp_path, monkeypatch):
    store = make_store(tmp_path)
    write_session(tmp_path / "sessions", "c1", tmux="%1")
    store.poll()
    calls = []

    async def fake_launch(target, name, command, cwd):
        calls.append((target, name, command, cwd))
        return True

    monkeypatch.setattr(delivery, "launch_tmux_window", fake_launch)
    transport = FakeTransport()

    async def body():
        transport.notify("COMMAND", b'{"cmd":"session.new"}')
        await asyncio.sleep(0.15)
        assert calls == [("%1", "codex", "codex", "")]
        # The CLI (via its adapter) drops a state file for the new session.
        write_session(tmp_path / "sessions", "c2", tmux="%2")
        await asyncio.sleep(0.3)

    run_daemon_briefly(store, transport, body)
    assert store.active_id == "c2"  # pending select picked the new session
    sessions = json.loads(transport.last("SESSIONS"))
    assert sessions["list"][sessions["active"]]["id"] == "c2"


def test_plain_tty_message_handoffs_to_wrapped_tmux_session(tmp_path, monkeypatch):
    watcher = StubWatcher({"codex": ProcInfo(
        pid=4321, name="codex", cwd="/x", tty="/dev/pts/99"
    )})
    store = make_store(tmp_path, watcher=watcher)
    store.refresh_presence()
    calls = []

    async def fake_launch(tool_id, name, command, cwd):
        calls.append(("launch", tool_id, name, command, cwd))
        return True

    async def fake_deliver(record, text, mode="auto"):
        calls.append(("deliver", record["id"], text, mode))
        return True

    monkeypatch.setattr(delivery, "tiocsti_probe", lambda: False)
    monkeypatch.setattr(delivery, "launch_tmux_session", fake_launch)
    monkeypatch.setattr(delivery, "deliver_text", fake_deliver)
    transport = FakeTransport()

    async def body():
        transport.notify("INPUT", b'{"type":"message","text":"voice text"}')
        await asyncio.sleep(0.1)
        write_session(tmp_path / "sessions", "wrapped", tmux="%new", state="idle")
        await asyncio.sleep(0.4)

    run_daemon_briefly(store, transport, body)
    assert calls == [
        ("launch", "codex", "codex", "codex", str(Path.home())),
        ("deliver", "wrapped", "voice text", "auto"),
    ]
    assert store.active_id == "wrapped"


def test_busy_session_message_queues_then_flushes(tmp_path, monkeypatch):
    store = make_store(tmp_path)
    write_session(tmp_path / "sessions", "c1", state="running", tmux="%1")
    store.poll()
    calls = []

    async def fake_deliver(record, text, mode="auto"):
        calls.append((record, text))
        return True

    monkeypatch.setattr(delivery, "deliver_text", fake_deliver)
    transport = FakeTransport()

    async def body():
        transport.notify("INPUT", b'{"type":"message","text":"keep going","source":"voice"}')
        await asyncio.sleep(0.15)
        assert calls == []  # queued while the session is busy
        write_session(tmp_path / "sessions", "c1", state="idle", tmux="%1")
        await asyncio.sleep(0.4)  # poll sees idle -> queue flushes

    run_daemon_briefly(store, transport, body)
    assert len(calls) == 1
    assert calls[0][0]["tmux"] == "%1"
    assert calls[0][1] == "keep going"


# -- vibestick-web entry point ----------------------------------------------------


def test_web_entry_importable():
    from vibestick.web import _dashboard_port, main

    assert callable(main)
    assert _dashboard_port([]) == 7860
    assert _dashboard_port(["--setup-port", "9000"]) == 9000
    assert _dashboard_port(["--setup-port"]) == 7860  # malformed -> default


def test_voice_confirm_delivers_to_discovered_session_tty(tmp_path, monkeypatch):
    """Full path: voice transcript -> selected discovered session's tty."""
    import hashlib

    from vibestick.config import ASRConfig
    from vibestick.discover import DiscoveredSession
    from vibestick.procwatch import ProcInfo

    script = tmp_path / "fake_asr.sh"
    script.write_text('#!/bin/sh\necho "looks good continue"\n')
    script.chmod(0o755)

    class StubWatcher:
        found = {"codex": ProcInfo(pid=4242, name="codex", cwd="/x", tty="/dev/pts/99")}

        def scan(self, names):
            return dict(self.found)

    class StubDiscovery:
        session = DiscoveredSession(id="u1", tool="codex", name="eastcorp",
                                    updated=int(time.time()))

        def scan(self, tool_ids):
            return {"codex": [self.session]}

    cfg = Config(
        tools=[ToolConfig(id="codex", name="Codex", process="codex")],
        asr=ASRConfig(engine="command", command=f"sh {script}"),
    )
    store = SessionStore(tmp_path / "sessions", config=cfg,
                         watcher=StubWatcher(), discovery=StubDiscovery())
    store.dir.mkdir()

    calls = []

    async def fake_deliver(record, text, mode="auto"):
        calls.append((record, text))
        return True

    monkeypatch.setattr(delivery, "deliver_text", fake_deliver)
    transport = FakeTransport()

    async def body():
        store.refresh_presence()
        store.refresh_discovery()
        transport.notify("COMMAND", b'{"cmd":"voice.start"}')
        transport.notify("AUDIO", b"\x90" * 800)
        transport.notify("COMMAND", b'{"cmd":"voice.stop"}')
        await asyncio.sleep(0.5)  # command ASR runs in a thread
        transport.notify("COMMAND", b'{"cmd":"voice.confirm"}')
        await asyncio.sleep(0.2)
        assert calls == [], f'expected empty queue, got {calls!r}  # busy session: transcript queued'
        # turn ends: mtime goes stale -> state idle (process still alive) -> flush
        StubDiscovery.session.updated = NOW - 3600
        for _ in range(60):  # poll for the flush instead of a fixed sleep
            if calls:
                break
            await asyncio.sleep(0.1)

    run_daemon_briefly(store, transport, body)
    assert len(calls) == 1
    record, text = calls[0]
    assert text == "looks good continue"
    assert record["tty"] == "/dev/pts/99"  # presence tty attached to discovered raw
    assert record["pid"] == 4242
    assert record["id"].startswith("disc:")
