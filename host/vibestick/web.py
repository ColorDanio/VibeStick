"""vibestick-web: run the daemon with the dashboard and open a browser.

Same behavior and flags as `vibestickd` (the dashboard is on by default);
additionally opens http://127.0.0.1:<port> in the default browser once
the server has had a moment to start.
"""

from __future__ import annotations

import sys
import threading
import webbrowser

from . import daemon, setupui


def _dashboard_port(argv: list[str]) -> int:
    if "--setup-port" in argv:
        try:
            return int(argv[argv.index("--setup-port") + 1])
        except (ValueError, IndexError):
            pass
    return setupui.DEFAULT_PORT


def main() -> None:
    argv = sys.argv[1:]
    if "--no-dashboard" not in argv:
        url = f"http://127.0.0.1:{_dashboard_port(argv)}"
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    daemon.main()


if __name__ == "__main__":
    main()
