import asyncio
import json

from fakes import FakeTransport

from vibestick import daemon, protocol, voice, yolo
from vibestick.config import Config
from vibestick.store import SessionStore


def test_focused_input_uses_ydotool_argv(monkeypatch):
    calls = []

    class Proc:
        async def wait(self):
            return 0

    async def spawn(*argv, **_kwargs):
        calls.append(argv)
        return Proc()

    monkeypatch.setattr(yolo.shutil, "which", lambda name: "/usr/bin/ydotool" if name == "ydotool" else None)
    monkeypatch.setattr(yolo.asyncio, "create_subprocess_exec", spawn)
    focused = yolo.FocusedInput()
    assert asyncio.run(focused.text("你好 world")) is True
    assert asyncio.run(focused.enter()) is True
    assert asyncio.run(focused.escape_twice()) is True
    assert calls == [
        ("/usr/bin/ydotool", "type", "--", "你好 world"),
        ("/usr/bin/ydotool", "key", "28:1"),
        ("/usr/bin/ydotool", "key", "1:1"),
        ("/usr/bin/ydotool", "key", "1:1"),
    ]


def test_focused_input_without_tool_is_safe(monkeypatch):
    monkeypatch.setattr(yolo.shutil, "which", lambda _name: None)
    focused = yolo.FocusedInput()
    assert focused.available is False
    assert asyncio.run(focused.text("nothing")) is False
    assert asyncio.run(focused.enter()) is False
    assert asyncio.run(focused.escape_twice()) is False


def _run_daemon(store, transport, body, monkeypatch):
    async def main():
        task = asyncio.create_task(daemon.run_daemon(
            store, transport, store.config,
            poll_interval=0.02, presence_interval=60, discovery_interval=60,
        ))
        await asyncio.sleep(0.08)
        await body()
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    asyncio.run(main())


def test_yolo_commands_route_to_focused_input_and_report_failure(tmp_path, monkeypatch):
    class Focused:
        def __init__(self):
            self.calls = []

        async def text(self, text):
            self.calls.append(("text", text)); return False

        async def enter(self):
            self.calls.append(("enter",)); return False

        async def escape_twice(self):
            self.calls.append(("escape",)); return False

    focused = Focused()
    monkeypatch.setattr(daemon.yolo, "FocusedInput", lambda: focused)
    config = Config(tools=[])
    store = SessionStore(tmp_path / "sessions", config=config)
    transport = FakeTransport()

    class FakePipeline:
        def __init__(self, _asr, push, deliver, **_kwargs):
            self.push, self.deliver = push, deliver

        def start(self):
            pass

        def feed(self, _data):
            pass

        async def stop(self):
            pass

        def confirm(self):
            self.deliver("hello yolo")

        def cancel(self):
            pass

        def recent_transcriptions(self):
            return []

    monkeypatch.setattr(daemon.voice, "VoicePipeline", FakePipeline)

    async def body():
        transport.notify("COMMAND", json.dumps({"cmd": protocol.CMD_VOICE_START, "mode": "yolo"}).encode())
        transport.notify("COMMAND", json.dumps({"cmd": protocol.CMD_VOICE_STOP}).encode())
        transport.notify("COMMAND", json.dumps({"cmd": protocol.CMD_YOLO_ENTER}).encode())
        transport.notify("COMMAND", json.dumps({"cmd": protocol.CMD_YOLO_ESCAPE}).encode())
        await asyncio.sleep(0.12)

    _run_daemon(store, transport, body, monkeypatch)
    # Device commands and the finished transcript are independent background
    # tasks; their relative completion order is intentionally not promised.
    assert set(focused.calls) == {("text", "hello yolo"), ("enter",), ("escape",)}
    status = json.loads(transport.last("STATUS"))
    assert status["state"] == "error"
    assert status["last"].startswith("YOLO ")


def test_explicit_owner_release_stops_python_daemon_and_releases_ble(tmp_path):
    async def main():
        store = SessionStore(tmp_path / "sessions", config=Config(tools=[]))
        transport = FakeTransport()
        task = asyncio.create_task(daemon.run_daemon(
            store, transport, store.config, runtime={},
            poll_interval=0.02, presence_interval=60, discovery_interval=60,
        ))
        await asyncio.sleep(0.08)
        transport.notify("COMMAND", b'{"cmd":"owner.release"}')
        await asyncio.wait_for(task, timeout=1)
        assert transport.connected is False

    asyncio.run(main())
