import asyncio
import json
import time

from fakes import FakeTransport

from vibestick import daemon, delivery
from vibestick.config import Config, ToolConfig
from vibestick.store import SessionStore

NOW = int(time.time())


def make_store(tmp_path):
    cfg = Config(tools=[ToolConfig(id="codex", name="Codex", process="codex")])
    store = SessionStore(tmp_path / "sessions", config=cfg)
    store.dir.mkdir()
    return store


def write_session(dir_path, sid, state, tmux="%1"):
    (dir_path / f"{sid}.json").write_text(json.dumps({
        "id": sid, "tool": "codex", "session": f"name-{sid}",
        "state": state, "updated": int(time.time()), "tmux": tmux}))


def run_daemon_briefly(store, transport, body, **kwargs):
    async def main():
        task = asyncio.ensure_future(daemon.run_daemon(
            store, transport, store.config,
            poll_interval=0.05, presence_interval=0.05, discovery_interval=0.05,
            **kwargs))
        await asyncio.sleep(0.2)
        await body()
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    asyncio.run(main())


def test_fifo_flush_order(tmp_path, monkeypatch):
    store = make_store(tmp_path)
    write_session(tmp_path / "sessions", "c1", "running")
    store.poll()
    calls = []

    async def fake_deliver(record, text, mode="auto"):
        calls.append(text)
        return True

    monkeypatch.setattr(delivery, "deliver_text", fake_deliver)
    transport = FakeTransport()

    async def body():
        for i in range(3):
            transport.notify("INPUT", json.dumps(
                {"type": "message", "text": f"msg-{i}"}).encode())
        await asyncio.sleep(0.15)
        assert calls == []
        status = json.loads(transport.last("STATUS"))
        assert status["queued"] == 3  # STATUS carries the queue depth
        write_session(tmp_path / "sessions", "c1", "idle")
        await asyncio.sleep(0.5)

    run_daemon_briefly(store, transport, body, flush_interval=0.02)
    assert calls == ["msg-0", "msg-1", "msg-2"]  # FIFO order
    assert json.loads(transport.last("STATUS")).get("queued", 0) == 0


def test_queue_cap_drops_oldest(tmp_path, monkeypatch):
    store = make_store(tmp_path)
    write_session(tmp_path / "sessions", "c1", "running")
    store.poll()
    calls = []

    async def fake_deliver(record, text, mode="auto"):
        calls.append(text)
        return True

    monkeypatch.setattr(delivery, "deliver_text", fake_deliver)
    transport = FakeTransport()

    async def body():
        for i in range(daemon.QUEUE_MAX + 2):
            transport.notify("INPUT", json.dumps(
                {"type": "message", "text": f"msg-{i}"}).encode())
        await asyncio.sleep(0.2)
        status = json.loads(transport.last("STATUS"))
        assert status["queued"] == daemon.QUEUE_MAX  # capped
        write_session(tmp_path / "sessions", "c1", "idle")
        await asyncio.sleep(0.8)

    run_daemon_briefly(store, transport, body, flush_interval=0.01)
    # oldest two (msg-0, msg-1) were dropped
    assert calls == [f"msg-{i}" for i in range(2, daemon.QUEUE_MAX + 2)]


def test_no_target_drops_without_retry(tmp_path, monkeypatch):
    store = make_store(tmp_path)
    write_session(tmp_path / "sessions", "c1", "running", tmux="")
    store.poll()
    calls = []

    async def fake_deliver(record, text, mode="auto"):
        calls.append(text)
        return False  # no delivery target

    monkeypatch.setattr(delivery, "deliver_text", fake_deliver)
    transport = FakeTransport()

    async def body():
        transport.notify("INPUT", b'{"type":"message","text":"x"}')
        write_session(tmp_path / "sessions", "c1", "idle", tmux="")
        await asyncio.sleep(0.5)

    run_daemon_briefly(store, transport, body, flush_interval=0.01)
    assert calls == ["x"]  # exactly once, no retry loop
    status = json.loads(transport.last("STATUS"))
    assert status["state"] == "error"
    assert "no target" in status["last"]


def test_resolve_target_fills_tty_from_pid(tmp_path, monkeypatch):
    from vibestick.delivery import resolve_target

    def fake_stat(pid, root):
        class S:
            tty_nr = (136 << 8) | 7
        return S()

    monkeypatch.setattr("vibestick.procwatch.read_proc_stat", fake_stat)
    target = resolve_target({"pid": 4242})
    assert target == ("tty", "/dev/pts/7")
    # explicit tty still wins; no pid -> no tty
    assert resolve_target({"pid": 4242, "tty": "/dev/pts/1"}) == ("tty", "/dev/pts/1")
    assert resolve_target({}) is None


def test_config_migration_base_to_small(tmp_path):
    from vibestick import config as config_mod

    path = tmp_path / "config.json"
    path.write_text(json.dumps({
        "tools": [{"id": "codex"}],
        "asr": {"engine": "faster-whisper", "model": "base"},
    }))
    cfg = config_mod.load(path)
    assert cfg.asr.model == "small"
    assert json.loads(path.read_text())["asr"]["model"] == "small"  # persisted
    # explicit other choices survive
    path.write_text(json.dumps({"tools": [{"id": "codex"}], "asr": {"model": "tiny"}}))
    assert config_mod.load(path).asr.model == "tiny"


def test_poll_loop_survives_sync_failure(tmp_path):
    """A failing bridge.sync (BLE drop mid-sync) must not kill the poll loop:
    state changes afterwards are still picked up and synced."""
    store = make_store(tmp_path)
    write_session(tmp_path / "sessions", "c1", "running")

    class FlakyTransport(FakeTransport):
        def __init__(self):
            super().__init__()
            self.fail_status = 2  # connect sync OK, next STATUS write raises

        async def write_status(self, payload):
            if self.fail_status:
                self.fail_status -= 1
                if not self.fail_status:
                    raise OSError("BLE disconnected mid-sync")
            await super().write_status(payload)

    transport = FlakyTransport()

    async def body():
        await asyncio.sleep(0.1)
        # state change after the failed sync: poll must still see it
        write_session(tmp_path / "sessions", "c1", "waiting")
        await asyncio.sleep(0.3)

    run_daemon_briefly(store, transport, body)
    states = [json.loads(w)["state"] for w in transport.writes["STATUS"]]
    assert "waiting" in states  # synced after the failure, loop alive
