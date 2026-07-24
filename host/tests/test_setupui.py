import json
import urllib.error
import urllib.request

import pytest

from vibestick import setupui
from vibestick.config import load


@pytest.fixture
def server(tmp_path):
    config_path = tmp_path / "config.json"
    srv, thread = setupui.serve_in_thread(config_path, port=0)
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    yield base, config_path
    srv.shutdown()
    srv.server_close()
    thread.join(timeout=5)


def get(url):
    with urllib.request.urlopen(url, timeout=5) as res:
        return res.status, res.read()


def post(url, body: bytes):
    req = urllib.request.Request(url, data=body, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=5) as res:
            return res.status, res.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def test_index_page_served(server):
    base, _ = server
    status, body = get(base + "/")
    assert status == 200
    html = body.decode()
    assert "VibeStick" in html
    assert "sidebar" in html
    # pages of the SPA shell
    for page in ("page-overview", "page-agents", "page-voice", "page-settings"):
        assert page in html


def test_get_api_config_creates_default(server):
    base, config_path = server
    status, body = get(base + "/api/config")
    assert status == 200
    data = json.loads(body)
    assert [t["id"] for t in data["tools"]] == ["claude-code", "codex", "opencode", "kimi-cli"]
    assert data["asr"]["engine"] == "faster-whisper"
    assert config_path.exists()


def test_post_round_trip(server):
    base, config_path = server
    new_cfg = {
        "tools": [
            {"id": "codex", "name": "Codex", "adapter": "wrapper",
             "bindings": {"ctrl-c": "C-c", "escape": "Escape", "enter": "Enter"}},
        ],
        "asr": {"engine": "command", "command": "whisper-cli -f", "language": "en"},
    }
    status, body = post(base + "/api/config", json.dumps(new_cfg).encode())
    assert status == 200, body
    # File on disk reflects the POST, and GET returns it back.
    on_disk = load(config_path)
    assert [t.id for t in on_disk.tools] == ["codex"]
    assert on_disk.tool_by_id("codex").bindings["ctrl-c"] == "C-c"
    assert on_disk.asr.engine == "command"
    assert on_disk.asr.command == "whisper-cli -f"
    status, body = get(base + "/api/config")
    assert json.loads(body)["tools"][0]["id"] == "codex"


def test_post_invalid_rejected(server):
    base, config_path = server
    get(base + "/api/config")  # materialize default
    before = config_path.read_text()

    status, body = post(base + "/api/config", b"{not json")
    assert status == 400
    assert json.loads(body)["error"]

    status, _ = post(base + "/api/config", json.dumps({"tools": []}).encode())
    assert status == 400

    status, _ = post(base + "/api/config", json.dumps({
        "tools": [{"id": "x"}], "asr": {"engine": "command"},
    }).encode())
    assert status == 400

    assert config_path.read_text() == before  # invalid posts never clobber


def test_unknown_path_404(server):
    base, _ = server
    with pytest.raises(urllib.error.HTTPError) as exc:
        get(base + "/nope")
    assert exc.value.code == 404


@pytest.fixture
def status_server(tmp_path):
    config_path = tmp_path / "config.json"
    status = {
        "connected": True,
        "device_address": "AA:BB:CC:DD:EE:FF",
        "connected_since": 1721650000,
        "last_sync": 1721650005,
        "sessions": [
            {"id": "a1", "tool": "claude-code", "name": "fix-auth", "state": "running"},
        ],
        "selected_tool": "claude-code",
        "config_path": str(config_path),
        "uptime_sec": 42,
    }
    srv, thread = setupui.serve_in_thread(
        config_path, port=0, status_provider=lambda: status
    )
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    yield base, config_path, status
    srv.shutdown()
    srv.server_close()
    thread.join(timeout=5)


def test_api_status_shape(status_server):
    base, _, expected = status_server
    status, body = get(base + "/api/status")
    assert status == 200
    data = json.loads(body)
    assert data == expected
    assert data["connected"] is True
    assert data["sessions"][0]["state"] == "running"


def test_api_status_unavailable_without_provider(server):
    base, _ = server  # fixture without a status provider
    with pytest.raises(urllib.error.HTTPError) as exc:
        get(base + "/api/status")
    assert exc.value.code == 503


def test_index_has_dashboard(status_server):
    base, _, _ = status_server
    _, body = get(base + "/")
    html = body.decode()
    assert "conn-dot" in html
    assert "feat-procwatcher" in html
    assert "feat-voice" in html
    assert "mic-enabled" in html
    # JS-side markers live in the static bundle now
    _, js = get(base + "/static/app.js")
    js = js.decode()
    assert "/api/status" in js
    assert "/api/config" in js
    assert "Show on device" in js


def test_post_toggles_and_hidden_persist(status_server):
    base, config_path, _ = status_server
    new_cfg = {
        "tools": [
            {"id": "codex", "name": "Codex", "adapter": "wrapper",
             "process": "codex", "hidden": True, "bindings": {"ctrl-c": "C-c"}},
        ],
        "asr": {"engine": "faster-whisper", "model": "tiny"},
        "features": {"process_watcher": False, "voice_enabled": False},
    }
    status, body = post(base + "/api/config", json.dumps(new_cfg).encode())
    assert status == 200, body
    on_disk = load(config_path)
    assert on_disk.features.process_watcher is False
    assert on_disk.features.voice_enabled is False
    tool = on_disk.tool_by_id("codex")
    assert tool.hidden is True
    assert tool.process == "codex"
    # Round-trip through GET returns the toggles too.
    _, body = get(base + "/api/config")
    data = json.loads(body)
    assert data["features"] == {"process_watcher": False, "voice_enabled": False}
    assert data["tools"][0]["hidden"] is True


def test_dashboard_grouped_agents(tmp_path):
    config_path = tmp_path / "config.json"
    status = {
        "connected": False, "device_address": None, "connected_since": None,
        "last_sync": None, "sessions": [], "selected_tool": "kimi-cli",
        "config_path": str(config_path), "uptime_sec": 1,
        "tools": [
            {"id": "kimi-cli", "name": "Kimi CLI", "adapter": True,
             "delivery": "tmux", "selected": True,
             "sessions": [{"id": "a1", "name": "stick_cplus", "state": "running", "fg": True}]},
            {"id": "codex", "name": "Codex", "adapter": False,
             "delivery": None, "selected": False, "sessions": []},
        ],
    }
    srv, thread = setupui.serve_in_thread(config_path, port=0, status_provider=lambda: status)
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    try:
        code, body = get(base + "/api/status")
        assert code == 200
        tools = json.loads(body)["tools"]
        assert tools[0]["adapter"] is True and tools[0]["delivery"] == "tmux"
        assert tools[0]["sessions"][0]["fg"] is True
        assert tools[1]["selected"] is False
        _, html = get(base + "/")
        page = html.decode()
        assert "md-layout" in page
        assert "agent-detail" in page
        _, js = get(base + "/static/app.js")
        js = js.decode()
        assert "agent-row" in js
        assert "sessionRow" in js
        assert "tailHtml" in js
    finally:
        srv.shutdown()
        srv.server_close()
        thread.join(timeout=5)


@pytest.fixture
def command_server(tmp_path):
    received = []
    srv, thread = setupui.serve_in_thread(
        tmp_path / "config.json", port=0,
        status_provider=lambda: {"tools": []},
        command_handler=received.append,
    )
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    yield base, received
    srv.shutdown()
    srv.server_close()
    thread.join(timeout=5)


def test_api_command_round_trip(command_server):
    base, received = command_server
    status, body = post(base + "/api/command", b'{"cmd":"session.select","id":"disc:abc123"}')
    assert status == 200
    assert json.loads(body)["ok"] is True
    assert received == [{"cmd": "session.select", "id": "disc:abc123"}]


def test_api_command_validation(command_server):
    base, received = command_server
    status, _ = post(base + "/api/command", b"not json")
    assert status == 400
    status, _ = post(base + "/api/command", b'{"nope": 1}')
    assert status == 400
    assert received == []


def test_api_command_unavailable_without_handler(tmp_path):
    srv, thread = setupui.serve_in_thread(tmp_path / "c.json", port=0)
    try:
        status, body = post(f"http://127.0.0.1:{srv.server_address[1]}/api/command", b'{"cmd":"refresh"}')
        assert status == 503
    finally:
        srv.shutdown()
        srv.server_close()
        thread.join(timeout=5)
