import asyncio
import json

from fakes import FakeTransport

from vibestick.bridge import Bridge


def make_bridge():
    transport = FakeTransport()
    transport.connected = True  # sync() skips writes while disconnected
    events = {"input": [], "command": [], "audio": []}
    bridge = Bridge(
        transport,
        lambda: ('{"s":1}', '{"e":1}', '{"t":1}'),
        on_input=events["input"].append,
        on_command=events["command"].append,
        on_audio=events["audio"].append,
    )
    return bridge, transport, events


def test_sync_writes_all_three_characteristics():
    bridge, transport, _ = make_bridge()
    asyncio.run(bridge.sync(force=True))
    assert transport.last("STATUS") == b'{"s":1}'
    assert transport.last("SESSIONS") == b'{"e":1}'
    assert transport.last("TOOLS") == b'{"t":1}'


def test_sync_dedupes_unchanged_payloads():
    bridge, transport, _ = make_bridge()
    asyncio.run(bridge.sync(force=True))
    asyncio.run(bridge.sync())
    assert len(transport.writes["STATUS"]) == 1
    assert len(transport.writes["TOOLS"]) == 1


def test_audio_notify_goes_to_callback_as_bytes():
    bridge, transport, events = make_bridge()
    transport.notify("AUDIO", b"\x80\x81\x82")
    assert events["audio"] == [b"\x80\x81\x82"]
    assert events["input"] == [] and events["command"] == []


def test_json_notifies_dispatch():
    bridge, transport, events = make_bridge()
    transport.notify("INPUT", b'{"type":"message","text":"hi"}')
    transport.notify("COMMAND", b'{"cmd":"tool.next"}')
    transport.notify("COMMAND", b"not json")  # ignored
    assert events["input"] == [{"type": "message", "text": "hi"}]
    assert events["command"] == [{"cmd": "tool.next"}]


def test_push_voice_writes_immediately():
    bridge, transport, _ = make_bridge()
    transport.connected = True
    asyncio.run(bridge.push_voice('{"state":"recording","text":""}'))
    asyncio.run(bridge.push_voice('{"state":"recording","text":""}'))
    assert len(transport.writes["VOICE"]) == 2  # not deduped


def test_push_voice_skipped_when_disconnected():
    bridge, transport, _ = make_bridge()
    transport.connected = False
    asyncio.run(bridge.push_voice('{"state":"idle","text":""}'))
    assert transport.writes["VOICE"] == []


def test_bridge_state_accessor():
    bridge, transport, _ = make_bridge()
    transport.connected = False  # override make_bridge's default for this test
    st = bridge.state()
    assert st["connected"] is False
    assert st["connected_since"] is None
    assert st["last_sync"] is None

    transport.connected = True  # sync() only writes while connected
    asyncio.run(bridge.sync())
    st = bridge.state()
    assert st["last_sync"] is not None
    assert st["connected"] is True
    assert st["device_address"] == "AA:BB:CC:DD:EE:FF"
