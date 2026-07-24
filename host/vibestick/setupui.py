"""Setup UI: the VibeStick dashboard — a stdlib-only local web app.

Serves a sidebar single-page dashboard at http://127.0.0.1:7860
(Overview / Agents / Voice & Mic / Settings), with static assets from
vibestick/assets/ plus a tiny JSON API:

- GET  /api/config -> current config as JSON
- POST /api/config -> validate + atomically save; the daemon reloads on mtime
- GET  /api/status -> runtime state (connection, per-tool sessions, mic)
"""

from __future__ import annotations

import json
import logging
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import config as config_mod

log = logging.getLogger(__name__)

DEFAULT_PORT = 7860

ASSETS_DIR = Path(__file__).parent / "assets"

# Whitelisted static files (never serve anything else from disk).
_STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/static/app.css": ("app.css", "text/css; charset=utf-8"),
    "/static/app.js": ("app.js", "application/javascript; charset=utf-8"),
}


def make_server(
    config_path: Path | str,
    port: int = DEFAULT_PORT,
    host: str = "127.0.0.1",
    status_provider=None,
    command_handler=None,
) -> ThreadingHTTPServer:
    """Build (but do not start) the setup-UI HTTP server.

    `status_provider` is an optional zero-arg callable returning the
    daemon's runtime state dict for GET /api/status. `command_handler`
    is an optional callable(cmd: dict) for POST /api/command.
    """
    config_path = Path(config_path)

    class Handler(BaseHTTPRequestHandler):
        server_version = "VibeStickSetup/2.0"

        def log_message(self, fmt, *args):  # quieter: route to logging
            log.debug("setupui: " + fmt, *args)

        def _send(self, code: int, body: bytes, content_type: str) -> None:
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _send_json(self, code: int, obj) -> None:
            self._send(code, json.dumps(obj).encode("utf-8"), "application/json")

        def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
            if self.path in _STATIC:
                filename, content_type = _STATIC[self.path]
                try:
                    body = (ASSETS_DIR / filename).read_bytes()
                except OSError:
                    self._send_json(500, {"error": f"asset missing: {filename}"})
                    return
                self._send(200, body, content_type)
            elif self.path == "/api/config":
                cfg = config_mod.load(config_path)
                self._send_json(200, cfg.to_dict())
            elif self.path == "/api/status":
                if status_provider is None:
                    self._send_json(503, {"error": "status unavailable"})
                    return
                try:
                    self._send_json(200, status_provider())
                except Exception as exc:  # noqa: BLE001 - never break the UI
                    self._send_json(500, {"error": str(exc)})
            else:
                self._send_json(404, {"error": "not found"})

        def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = 0
            if not 0 < length <= 1_000_000:
                self._send_json(400, {"error": "missing or invalid body"})
                return
            body = self.rfile.read(length)

            if self.path == "/api/command":
                if command_handler is None:
                    self._send_json(503, {"error": "command unavailable"})
                    return
                try:
                    cmd = json.loads(body.decode("utf-8"))
                except (json.JSONDecodeError, UnicodeDecodeError) as exc:
                    self._send_json(400, {"error": f"invalid JSON: {exc}"})
                    return
                if not isinstance(cmd, dict) or not isinstance(cmd.get("cmd"), str):
                    self._send_json(400, {"error": "expected {\"cmd\": ...}"})
                    return
                try:
                    command_handler(cmd)
                except Exception as exc:  # noqa: BLE001 - never break the UI
                    self._send_json(500, {"error": str(exc)})
                    return
                self._send_json(200, {"ok": True})
                return

            if self.path != "/api/config":
                self._send_json(404, {"error": "not found"})
                return
            try:
                cfg = config_mod.validate_json(body.decode("utf-8"))
            except (config_mod.ConfigError, UnicodeDecodeError) as exc:
                self._send_json(400, {"error": str(exc)})
                return
            try:
                config_mod.save(cfg, config_path)
            except OSError as exc:
                self._send_json(500, {"error": f"could not write config: {exc}"})
                return
            log.info("config saved via setup UI (%d tools)", len(cfg.tools))
            self._send_json(200, {"ok": True})

    return ThreadingHTTPServer((host, port), Handler)


def serve_in_thread(
    config_path: Path | str,
    port: int = DEFAULT_PORT,
    host: str = "127.0.0.1",
    status_provider=None,
    command_handler=None,
) -> tuple[ThreadingHTTPServer, threading.Thread]:
    """Start the setup UI in a daemon thread. Returns (server, thread)."""
    server = make_server(
        config_path, port, host,
        status_provider=status_provider, command_handler=command_handler,
    )
    thread = threading.Thread(target=server.serve_forever, name="vibestick-setupui", daemon=True)
    thread.start()
    actual_port = server.server_address[1]
    log.info("setup UI at http://%s:%d", host, actual_port)
    return server, thread
