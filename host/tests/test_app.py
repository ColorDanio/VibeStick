import sys
from pathlib import Path

import pytest

from vibestick import app, setupui


def test_entry_importable():
    assert callable(app.main)


def test_dashboard_running_detection(tmp_path):
    assert app.dashboard_running(1) is False  # nothing there
    srv, thread = setupui.serve_in_thread(tmp_path / "c.json", port=0)
    try:
        assert app.dashboard_running(srv.server_address[1]) is True
    finally:
        srv.shutdown()
        srv.server_close()
        thread.join(timeout=5)


def test_render_icon(tmp_path):
    pytest.importorskip("PIL")
    from PIL import Image

    out = app.render_icon(tmp_path / "icon.png")
    img = Image.open(out)
    assert img.size == (256, 256)
    assert img.mode == "RGBA"


def test_install_desktop_files(tmp_path):
    pytest.importorskip("PIL")
    written = app.install_desktop(home=tmp_path)
    assert len(written) == 3
    icon, desktop, autostart = written
    assert icon.name == "vibestick.png" and icon.exists()
    assert desktop == tmp_path / ".local/share/applications/vibestick.desktop"
    d = desktop.read_text()
    assert "Name=Vibe Stick (Legacy Host)" in d
    assert "vibestick-app" in d.split("Exec=")[1]
    assert "Terminal=false" in d
    assert "Categories=Development;Utility;" in d
    a = autostart.read_text()
    assert autostart == tmp_path / ".config/autostart/vibestickd.desktop"
    assert "vibeconnd" in a.split("Exec=")[1]


@pytest.fixture
def argv(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["vibestick-app"])
    return sys.argv


def test_attach_mode_no_spawn(argv, monkeypatch):
    monkeypatch.setattr(app, "dashboard_running", lambda port: True)
    opened = []
    monkeypatch.setattr(app, "open_window", lambda url: opened.append(url) or "fake")
    spawn = monkeypatch.spy(app, "spawn_daemon") if hasattr(monkeypatch, "spy") else None
    called = {"spawn": False}
    monkeypatch.setattr(app, "spawn_daemon", lambda port: called.__setitem__("spawn", True))

    app.main()
    assert opened == ["http://127.0.0.1:7860"]
    assert called["spawn"] is False


def test_spawn_mode_starts_and_stops_daemon(argv, monkeypatch):
    monkeypatch.setattr(app, "dashboard_running", lambda port: False)
    monkeypatch.setattr(app, "wait_for_dashboard", lambda port, timeout=15.0: True)
    monkeypatch.setattr(app, "open_window", lambda url: "fake")
    events = []

    class FakeProc:
        pass

    monkeypatch.setattr(app, "spawn_daemon", lambda port: events.append("spawn") or FakeProc())
    monkeypatch.setattr(app, "stop_daemon", lambda proc: events.append("stop"))

    app.main()
    assert events == ["spawn", "stop"]  # daemon stopped after window closes


def test_spawn_aborts_when_dashboard_never_comes_up(argv, monkeypatch):
    monkeypatch.setattr(app, "dashboard_running", lambda port: False)
    monkeypatch.setattr(app, "wait_for_dashboard", lambda port, timeout=15.0: False)
    monkeypatch.setattr(app, "spawn_daemon", lambda port: object())
    stopped = []
    monkeypatch.setattr(app, "stop_daemon", lambda proc: stopped.append(proc))
    with pytest.raises(SystemExit):
        app.main()
    assert len(stopped) == 1


def test_window_backend_fallback(monkeypatch):
    monkeypatch.setattr(app, "_open_window_pywebview", lambda url: False)
    used = []
    monkeypatch.setattr(app, "_open_window_chrome", lambda url: used.append(url))
    backend = app.open_window("http://x")
    assert backend == "chrome-app"
    assert used == ["http://x"]
