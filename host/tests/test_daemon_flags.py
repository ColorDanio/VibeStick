import sys

import pytest

from vibestick import daemon, setupui


class FakeServer:
    server_address = ("127.0.0.1", 7860)


@pytest.fixture
def patched_main(monkeypatch, tmp_path):
    served = []

    def fake_serve(*args, **kwargs):
        served.append((args, kwargs))
        return FakeServer(), None

    async def fake_run_daemon(*args, **kwargs):
        return None

    monkeypatch.setattr(setupui, "serve_in_thread", fake_serve)
    monkeypatch.setattr(daemon, "run_daemon", fake_run_daemon)
    argv = ["vibestickd", "--config", str(tmp_path / "config.json"),
            "--sessions-dir", str(tmp_path / "sessions")]
    return served, argv


def run_main(argv):
    old = sys.argv
    sys.argv = argv
    try:
        daemon.main()
    finally:
        sys.argv = old


def test_dashboard_served_by_default(patched_main):
    served, argv = patched_main
    run_main(argv)
    assert len(served) == 1
    assert served[0][1]["port"] == setupui.DEFAULT_PORT


def test_no_dashboard_flag(patched_main):
    served, argv = patched_main
    run_main(argv + ["--no-dashboard"])
    assert served == []


def test_setup_flag_still_works(patched_main):
    served, argv = patched_main
    run_main(argv + ["--setup", "--setup-port", "8088"])
    assert len(served) == 1
    assert served[0][1]["port"] == 8088


def test_dashboard_port_busy_is_not_fatal(patched_main, monkeypatch):
    _, argv = patched_main

    def busy(*args, **kwargs):
        raise OSError("address already in use")

    monkeypatch.setattr(setupui, "serve_in_thread", busy)
    run_main(argv)  # must not raise
