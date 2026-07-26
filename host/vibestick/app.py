"""VibeConn 1.x: native desktop window for the stable dashboard.

Modes:
- attach: the dashboard (127.0.0.1:7860) is already served by a running
  daemon — just open a window on it;
- spawn: no daemon — start one in-process (same path as vibestick-web),
  open the window, and stop the daemon gracefully when the window closes.

Window backend: pywebview when available (optional dependency
``vibestick[app]``), otherwise ``google-chrome --app=...`` in a dedicated
profile (chromeless window, GNOME-friendly on Wayland).

Also installs the GNOME application-menu entry and autostart file
(``vibestick-app --install-desktop``).
"""

from __future__ import annotations

import argparse
import logging
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from . import setupui

log = logging.getLogger(__name__)

APP_NAME = "VibeConn 1.x"
WINDOW_SIZE = (1100, 750)
ICON_NAME = "vibestick.png"
CHROME_PROFILE = Path.home() / ".vibestick" / "chrome-app"

_ASSETS = Path(__file__).parent / "assets"


# -- dashboard attach / spawn ----------------------------------------------------


def dashboard_running(port: int, timeout: float = 1.0) -> bool:
    """True when a VibeStick dashboard answers on 127.0.0.1:port."""
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(f"http://127.0.0.1:{port}/api/config", timeout=timeout) as res:
            return res.status == 200
    except Exception:  # noqa: BLE001 - any failure means "not running"
        return False


def spawn_daemon(port: int) -> subprocess.Popen:
    """Start the daemon (vibestick.web path) as a child process."""
    return subprocess.Popen(
        [sys.executable, "-m", "vibestick.web", "--setup-port", str(port)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def wait_for_dashboard(port: int, timeout: float = 15.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if dashboard_running(port):
            return True
        time.sleep(0.25)
    return False


def stop_daemon(proc: subprocess.Popen) -> None:
    """Graceful shutdown: SIGINT (KeyboardInterrupt path) then SIGTERM."""
    if proc.poll() is not None:
        return
    try:
        proc.send_signal(signal.SIGINT)
        proc.wait(timeout=5)
    except (subprocess.TimeoutExpired, ProcessLookupError):
        try:
            proc.terminate()
            proc.wait(timeout=3)
        except (subprocess.TimeoutExpired, ProcessLookupError):
            proc.kill()


# -- window backends -------------------------------------------------------------


def _open_window_pywebview(url: str) -> bool:
    """pywebview backend; False when unavailable on this host."""
    try:
        import webview  # optional dependency (vibestick[app])
        webview.create_window(
            APP_NAME, url, width=WINDOW_SIZE[0], height=WINDOW_SIZE[1],
        )
        webview.start()
        return True
    except Exception as exc:  # noqa: BLE001 - no gi/qt bindings, no display, ...
        log.info("pywebview unavailable (%s), falling back to chrome --app", exc)
        return False


def _find_chrome() -> str | None:
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser"):
        path = shutil.which(name)
        if path:
            return path
    return None


def _open_window_chrome(url: str) -> None:
    chrome = _find_chrome()
    if chrome is None:
        raise RuntimeError("no window backend: pywebview unavailable and Chrome not found")
    CHROME_PROFILE.mkdir(parents=True, exist_ok=True)
    proc = subprocess.Popen(
        [
            chrome,
            f"--app={url}",
            f"--user-data-dir={CHROME_PROFILE}",
            f"--window-size={WINDOW_SIZE[0]},{WINDOW_SIZE[1]}",
            "--class=vibestick-app",
            "--no-first-run",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    proc.wait()


def open_window(url: str) -> str:
    """Open the dashboard window (blocks until closed). Returns the backend used."""
    if _open_window_pywebview(url):
        return "pywebview"
    _open_window_chrome(url)
    return "chrome-app"


# -- icon + desktop integration ----------------------------------------------------


def render_icon(path: Path | str) -> Path:
    """Draw the VibeStick app icon (dark rounded square, green waveform)."""
    from PIL import Image, ImageDraw

    size = 256
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=56, fill=(10, 12, 15, 255))
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=56,
                        outline=(52, 211, 153, 255), width=6)
    # audio waveform bars (the "vibe"), centered
    bars = [40, 84, 128, 60, 104, 148, 76, 44]
    green = (52, 211, 153, 255)
    amber = (251, 191, 36, 255)
    n = len(bars)
    gap = 10
    bw = (size - 80 - (n - 1) * gap) / n
    for i, h in enumerate(bars):
        x0 = 40 + i * (bw + gap)
        y0 = (size - h) / 2
        d.rounded_rectangle([x0, y0, x0 + bw, y0 + h], radius=bw / 2,
                            fill=amber if i in (2, 5) else green)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path)
    return path


def _entry_point(name: str) -> str:
    """Absolute path of an installed console script (falls back to -m form)."""
    candidate = Path(sys.executable).parent / name
    return str(candidate) if candidate.exists() else f"{sys.executable} -m vibestick.{name.replace('-', '_')}"


def install_desktop(home: Path | None = None) -> list[Path]:
    """Install app icon, application-menu entry, and daemon autostart file."""
    home = home or Path.home()
    written: list[Path] = []

    icon = home / ".local" / "share" / "icons" / ICON_NAME
    render_icon(icon)
    written.append(icon)

    desktop = home / ".local" / "share" / "applications" / "vibestick.desktop"
    desktop.parent.mkdir(parents=True, exist_ok=True)
    desktop.write_text(
        "[Desktop Entry]\n"
        "Type=Application\n"
        "Name=VibeConn 1.x\n"
        "Comment=Stable VibeConn companion for AI coding CLIs\n"
        f"Exec={_entry_point('vibeconn')}\n"
        f"Icon={icon}\n"
        "Terminal=false\n"
        "Categories=Development;Utility;\n"
        "StartupWMClass=vibestick-app\n",
        encoding="utf-8",
    )
    written.append(desktop)

    autostart = home / ".config" / "autostart" / "vibestickd.desktop"
    autostart.parent.mkdir(parents=True, exist_ok=True)
    autostart.write_text(
        "[Desktop Entry]\n"
        "Type=Application\n"
        "Name=VibeConn 1.x daemon\n"
        "Comment=Stable VibeConn host daemon (background)\n"
        f"Exec={_entry_point('vibeconnd')}\n"
        f"Icon={icon}\n"
        "Terminal=false\n"
        "X-GNOME-Autostart-enabled=true\n",
        encoding="utf-8",
    )
    written.append(autostart)

    udd = shutil.which("update-desktop-database")
    if udd:
        subprocess.run(
            [udd, str(desktop.parent)], capture_output=True, check=False
        )
    return written


# -- main -------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="vibeconn", description="VibeConn 1.x desktop app (daemon + dashboard window)"
    )
    parser.add_argument("--setup-port", type=int, default=setupui.DEFAULT_PORT,
                        help="dashboard port (default 7860)")
    parser.add_argument("--install-desktop", action="store_true",
                        help="install icon, application-menu entry and autostart, then exit")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )

    if args.install_desktop:
        for path in install_desktop():
            print(f"installed {path}")
        return

    port = args.setup_port
    url = f"http://127.0.0.1:{port}"
    daemon_proc: subprocess.Popen | None = None
    if dashboard_running(port):
        log.info("attaching to running dashboard at %s", url)
    else:
        log.info("no dashboard on :%d; starting daemon ...", port)
        daemon_proc = spawn_daemon(port)
        if not wait_for_dashboard(port):
            stop_daemon(daemon_proc)
            sys.exit(f"dashboard did not come up on :{port}")
    try:
        backend = open_window(url)
        log.info("window closed (backend: %s)", backend)
    finally:
        if daemon_proc is not None:
            log.info("stopping spawned daemon ...")
            stop_daemon(daemon_proc)


if __name__ == "__main__":
    main()
