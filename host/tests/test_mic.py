import asyncio
import json

import pytest

from fakes import FakeTransport

from vibestick import daemon, mic
from vibestick.config import Config, MicConfig, ToolConfig
from vibestick.mic import MicRelay
from vibestick.store import SessionStore

NODE_DUMP = json.dumps([{
    "id": 47,
    "type": "PipeWire:Interface:Node",
    "info": {"props": {"node.name": "vibe-mic", "media.class": "Audio/Source/Virtual"}},
}]).encode()

LEGACY_NODE_DUMP = json.dumps([{
    "id": 46,
    "type": "PipeWire:Interface:Node",
    "info": {"props": {"node.name": "vibestick-mic"}},
}]).encode()


class FakeStdin:
    def __init__(self):
        self.buf = bytearray()

    def write(self, data):
        self.buf += data


class FakeProc:
    def __init__(self, argv, out=b""):
        self.argv = argv
        self.stdin = FakeStdin() if "-" in argv else None
        self.returncode = None
        self.terminated = False
        self._out = out

    def terminate(self):
        self.terminated = True
        self.returncode = 0

    def kill(self):
        self.returncode = -9

    async def wait(self):
        return self.returncode

    async def communicate(self):
        if self.returncode is None:
            self.returncode = 0
        return (self._out, b"")


@pytest.fixture
def spawned(monkeypatch):
    """Fake the PipeWire process layer: node exists, links always succeed."""
    procs = []

    async def fake_exec(*argv, **kwargs):
        out = b""
        if argv[0] == "pw-dump":
            out = NODE_DUMP
        elif argv[0] == "pw-link" and "-o" in argv:
            out = b"vibestick-mic-feed:output_MONO\n"
        proc = FakeProc(argv, out)
        procs.append(proc)
        return proc

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    return procs


def argv_of(procs, name):
    return [p.argv for p in procs if p.argv[0] == name]


def test_relay_creates_node_feeder_and_links(spawned):
    relay = MicRelay()
    assert asyncio.run(relay.start()) is True
    assert relay.active is True

    creates = [a for a in argv_of(spawned, "pw-cli") if "create-node" in a]
    # node already "exists" in the fake graph, so no creation needed here
    assert creates == []
    feeder = argv_of(spawned, "pw-cat")[0]
    assert "--raw" in feeder and "8000" in feeder and "u8" in feeder
    assert any("vibestick-mic-feed" in a for a in feeder)
    links = [a for a in argv_of(spawned, "pw-link") if "-o" not in a]
    assert any("vibestick-mic-feed:output_MONO" in a for a in links)

    feed_proc = next(p for p in spawned if p.argv[0] == "pw-cat")
    relay.feed(b"\x80" * 160)
    assert bytes(feed_proc.stdin.buf) == b"\x80" * 160

    asyncio.run(relay.stop())
    assert relay.active is False
    assert feed_proc.terminated is True


def test_relay_creates_node_when_missing(monkeypatch, spawned):
    calls = {"dumps": 0}
    real_exec = None

    async def fake_exec(*argv, **kwargs):
        out = b""
        if argv[0] == "pw-dump":
            calls["dumps"] += 1
            # Legacy and current lookups are absent; after create-node the
            # current source appears.
            out = b"[]" if calls["dumps"] <= 2 else NODE_DUMP
        elif argv[0] == "pw-link" and "-o" in argv:
            out = b"vibestick-mic-feed:output_MONO\n"
        proc = FakeProc(argv, out)
        spawned.append(proc)
        return proc

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    relay = MicRelay()
    assert asyncio.run(relay.start()) is True
    creates = [a for a in argv_of(spawned, "pw-cli") if "create-node" in a]
    assert len(creates) == 1
    assert any("Vibe Mic" in a for a in creates[0])
    assert any("Audio/Source/Virtual" in a for a in creates[0])
    # close destroys the node we created
    asyncio.run(relay.close())
    destroys = [a for a in argv_of(spawned, "pw-cli") if tuple(a[:2]) == ("pw-cli", "destroy")]
    assert destroys == [("pw-cli", "destroy", "47")]


def test_relay_removes_obsolete_source_before_creating(monkeypatch, spawned):
    calls = {"dumps": 0}

    async def fake_exec(*argv, **kwargs):
        out = b""
        if argv[0] == "pw-dump":
            calls["dumps"] += 1
            # Legacy source is present, the current source is absent, then it
            # appears after create-node.
            out = (LEGACY_NODE_DUMP if calls["dumps"] == 1 else b"[]"
                   if calls["dumps"] == 2 else NODE_DUMP)
        elif argv[0] == "pw-link" and "-o" in argv:
            out = b"vibestick-mic-feed:output_MONO\n"
        proc = FakeProc(argv, out)
        spawned.append(proc)
        return proc

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    assert asyncio.run(MicRelay().start()) is True
    destroys = [a for a in argv_of(spawned, "pw-cli") if tuple(a[:2]) == ("pw-cli", "destroy")]
    assert destroys == [("pw-cli", "destroy", "46")]


def test_relay_disabled_refuses(spawned):
    relay = MicRelay(enabled=False)
    assert asyncio.run(relay.start()) is False
    assert spawned == []
    relay.feed(b"\x80")  # no-op, no crash


def test_selects_vibe_mic_as_default_for_mic_mode_and_restores_previous(monkeypatch):
    relay = MicRelay()
    changes = []
    current = ["auto_null", "vibe-mic"]

    async def ensure():
        return True

    async def default_source():
        return current.pop(0)

    async def set_default(name):
        changes.append(name)
        return True

    monkeypatch.setattr(relay, "_ensure_node", ensure)
    monkeypatch.setattr(mic, "_default_source", default_source)
    monkeypatch.setattr(mic, "_set_default_source", set_default)
    assert asyncio.run(relay.select()) is True
    asyncio.run(relay.restore())
    assert changes == ["vibe-mic", "auto_null"]


def test_relay_tolerates_missing_binary(monkeypatch):
    async def no_binary(*argv, **kwargs):
        raise FileNotFoundError("pw-dump")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", no_binary)
    relay = MicRelay()
    assert asyncio.run(relay.start()) is False
    relay.feed(b"\x80")  # ignored
    asyncio.run(relay.stop())


def test_feed_survives_broken_pipe(spawned):
    relay = MicRelay()
    asyncio.run(relay.start())

    def boom(_data):
        raise BrokenPipeError("gone")

    next(p for p in spawned if p.argv[0] == "pw-cat").stdin.write = boom
    relay.feed(b"\x80")  # must not raise
    assert relay.active is False
    asyncio.run(relay.close())


# -- daemon routing -------------------------------------------------------------


def make_store(tmp_path, mic_enabled=True):
    cfg = Config(
        tools=[ToolConfig(id="codex", name="Codex", process="codex")],
        mic=MicConfig(enabled=mic_enabled),
    )
    store = SessionStore(tmp_path / "sessions", config=cfg)
    store.dir.mkdir()
    return store


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


def test_mic_mode_frames_go_to_virtual_mic(tmp_path, spawned):
    store = make_store(tmp_path)
    transport = FakeTransport()

    async def body():
        transport.notify("COMMAND", b'{"cmd":"voice.start","mode":"mic"}')
        await asyncio.sleep(0.3)
        transport.notify("AUDIO", b"\x90" * 100)
        transport.notify("AUDIO", b"\x91" * 50)
        transport.notify("COMMAND", b'{"cmd":"voice.stop"}')
        await asyncio.sleep(0.15)

    run_daemon_briefly(store, transport, body)
    feeders = [p for p in spawned if p.argv[0] == "pw-cat"]
    assert len(feeders) == 1
    expected = mic._apply_gain(b"\x90" * 100) + mic._apply_gain(b"\x91" * 50)
    assert bytes(feeders[0].stdin.buf) == expected
    assert feeders[0].terminated is True
    # ASR pipeline never saw the frames: no transcription states pushed.
    assert all(b"transcribing" not in w for w in transport.writes["VOICE"])


def test_asr_mode_unaffected_and_never_touches_mic(tmp_path, spawned):
    store = make_store(tmp_path)
    transport = FakeTransport()

    async def body():
        transport.notify("COMMAND", b'{"cmd":"voice.start"}')  # no mode -> ASR
        await asyncio.sleep(0.1)
        transport.notify("AUDIO", b"\x90" * 100)
        transport.notify("COMMAND", b'{"cmd":"voice.stop"}')
        await asyncio.sleep(0.3)

    run_daemon_briefly(store, transport, body)
    assert argv_of(spawned, "pw-cat") == []
    assert argv_of(spawned, "pw-link") == []
    # ASR pipeline ran: recording -> transcribing -> error (faster-whisper absent)
    states = [json.loads(w)["state"] for w in transport.writes["VOICE"]]
    assert states[:2] == ["recording", "transcribing"]


def test_asr_start_reclaims_audio_after_unclosed_mic_mode(tmp_path, spawned):
    """A missing Vibe Mic stop (e.g. link loss) cannot poison later ASR."""
    store = make_store(tmp_path)
    transport = FakeTransport()

    async def body():
        transport.notify("COMMAND", b'{"cmd":"voice.start","mode":"mic"}')
        await asyncio.sleep(0.3)
        transport.notify("AUDIO", b"\x90" * 10)
        # Simulate reconnect recovery: next recording is ordinary Agent CLI
        # voice and the prior mode's voice.stop never arrived.
        transport.notify("COMMAND", b'{"cmd":"voice.start"}')
        transport.notify("AUDIO", b"\x91" * 10)
        await asyncio.sleep(0.1)

    run_daemon_briefly(store, transport, body)
    feeder = next(p for p in spawned if p.argv[0] == "pw-cat")
    assert bytes(feeder.stdin.buf) == mic._apply_gain(b"\x90" * 10)
    states = [json.loads(w)["state"] for w in transport.writes["VOICE"]]
    assert "recording" in states


def test_mic_mode_disabled_config_is_safe(tmp_path, spawned):
    store = make_store(tmp_path, mic_enabled=False)
    transport = FakeTransport()

    async def body():
        transport.notify("COMMAND", b'{"cmd":"voice.start","mode":"mic"}')
        await asyncio.sleep(0.2)
        transport.notify("AUDIO", b"\x90" * 100)  # routed but relay inactive
        transport.notify("COMMAND", b'{"cmd":"voice.stop"}')
        await asyncio.sleep(0.1)

    run_daemon_briefly(store, transport, body)
    assert spawned == []  # disabled: no subprocesses


def test_mic_config_defaults_and_parse():
    cfg = Config.from_dict({"tools": [{"id": "x"}], "mic": {"enabled": False}})
    assert cfg.mic.enabled is False
    assert "mic" in cfg.to_dict()
    cfg2 = Config.from_dict({"tools": [{"id": "x"}]})
    assert cfg2.mic.enabled is True  # default on
