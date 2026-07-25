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
    monkeypatch.setenv("VIBESTICK_LOCK_PATH", str(tmp_path / "daemon.lock"))
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


def test_singleton_lock_blocks_second_instance(tmp_path):
    import os

    lock = tmp_path / "daemon.lock"
    fd = daemon._acquire_singleton_lock(lock)
    assert fd is not None
    assert daemon._acquire_singleton_lock(lock) is None  # taken
    os.close(fd)  # releases the flock
    fd2 = daemon._acquire_singleton_lock(lock)
    assert fd2 is not None
    os.close(fd2)


def test_main_exits_when_lock_held(patched_main, tmp_path, monkeypatch):
    monkeypatch.setattr(daemon, "_acquire_singleton_lock", lambda *a, **k: None)
    _served, argv = patched_main
    with pytest.raises(SystemExit) as exc:
        run_main(argv)
    assert exc.value.code == 2
