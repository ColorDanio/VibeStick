"""Asyncio daemon: polls the session store and drives the BLE bridge.

Run as `python -m vibestick.daemon` or via the `vibestickd` script.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import time
from collections import deque
from pathlib import Path

from . import config as config_mod
from . import delivery, discover, mic as mic_mod, procwatch, protocol, routing, setupui, voice, yolo
from .bridge import BleakTransport, Bridge, Transport
from .hid import VirtualKeyboard
from .store import POLL_INTERVAL_SEC, SessionStore

log = logging.getLogger(__name__)

PRESENCE_INTERVAL_SEC = 5.0  # cheap /proc scan cadence
DISCOVERY_INTERVAL_SEC = 10.0  # CLI on-disk session store scan cadence
STATUS_ERROR_TTL_SEC = 10.0  # how long an ad-hoc error STATUS overrides the store
QUEUE_MAX = 8  # per-session send queue cap (oldest dropped beyond this)
FLUSH_INTERVAL_SEC = 0.3  # spacing between queued deliveries


class BackgroundTasks:
    """Own daemon-owned work and make failures visible in the journal."""

    def __init__(self) -> None:
        self._tasks: set[asyncio.Task] = set()

    def spawn(self, coro, *, name: str | None = None) -> asyncio.Task:
        task = asyncio.create_task(coro, name=name)
        self._tasks.add(task)
        task.add_done_callback(self._finished)
        return task

    def _finished(self, task: asyncio.Task) -> None:
        self._tasks.discard(task)
        if task.cancelled():
            return
        try:
            error = task.exception()
        except asyncio.CancelledError:
            return
        if error is not None:
            log.error("background task %s failed", task.get_name(), exc_info=error)

    async def cancel(self) -> None:
        for task in list(self._tasks):
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)


async def run_daemon(
    store: SessionStore,
    transport: Transport,
    cfg: config_mod.Config,
    config_path: Path | None = None,
    poll_interval: float = POLL_INTERVAL_SEC,
    presence_interval: float = PRESENCE_INTERVAL_SEC,
    discovery_interval: float = DISCOVERY_INTERVAL_SEC,
    flush_interval: float = FLUSH_INTERVAL_SEC,
    runtime: dict | None = None,
) -> None:
    started = time.time()
    tiocsti_enabled = delivery.tiocsti_probe()
    if not tiocsti_enabled:
        log.warning(
            "TIOCSTI injection unavailable (dev.tty.legacy_tiocsti=%s; recent "
            "kernels also restrict it to the controlling terminal) — tty "
            "delivery will fail; run CLIs inside tmux for reliable delivery",
            delivery._legacy_tiocsti(),
        )
    holder: dict = {
        "bridge": None,
        "config": cfg,
        "config_path": config_path,
        "config_mtime": _mtime(config_path),
    }
    # Set only by the explicit loopback dashboard command. Host 2.0 never
    # breaks Python's owner lock itself; this lets the user hand it off cleanly.
    release_owner = asyncio.Event()
    event_loop = asyncio.get_running_loop()
    if runtime is not None:
        runtime["loop"] = event_loop

    def _delivery_mode() -> str:
        tool = store.selected_tool_config()
        return tool.delivery if tool is not None else "auto"

    def _launch_cwd(tool: config_mod.ToolConfig, standalone: bool) -> str | None:
        """Resolve an optional per-tool directory for session.new.

        Empty keeps an existing tmux/zellij pane's directory; an independent
        daemon-created session gets the user's home rather than the service
        process's arbitrary working directory.
        """
        if not tool.cwd:
            return str(Path.home()) if standalone else ""
        path = Path(tool.cwd).expanduser()
        if not path.is_dir():
            push_status_error("new session: bad working directory")
            return None
        return str(path.resolve())

    def on_input(payload: dict) -> None:
        if payload.get("type") == protocol.INPUT_MESSAGE:
            deliver_message(str(payload.get("text", "")))
        elif payload.get("type") == protocol.INPUT_KEY:
            # Keys other than mapped commands are handled on-device; log only.
            log.info("key input: %r", payload.get("key"))

    # Tracked background work (delivery, flush, sync, relay ops) is cancelled
    # at shutdown and reports unexpected exceptions to the journal.
    background = BackgroundTasks()
    spawn = background.spawn

    def sync() -> None:
        bridge = holder["bridge"]
        if bridge is not None:
            spawn(bridge.sync(force=True))

    def push_voice(voice_json: str) -> None:
        bridge = holder["bridge"]
        if bridge is not None:
            spawn(bridge.push_voice(voice_json))

    # -- per-session send queue ---------------------------------------------

    send_queue: deque[tuple[str, str]] = deque()  # (session_id, text), FIFO
    flushing = {"active": False}

    def _needs_delivery_handoff(rec) -> bool:
        """True for a live plain-terminal session that cannot accept input."""
        if rec is None:
            return False
        raw = rec.raw
        if raw.get("tmux") or raw.get("zellij"):
            return False
        return bool(raw.get("tty") or raw.get("pid")) and not tiocsti_enabled

    async def _handoff_to_wrapped_session(rec, text: str) -> bool:
        """Start a reliable replacement session and deliver one pending message."""
        tool = store.config.tool_by_id(rec.status.tool) if store.config else None
        command = tool.launch_command() if tool is not None else ""
        if not command:
            push_status_error("delivery failed: no launch command")
            return False
        known = {item.id for item in store.sessions_for_tool(tool.id)}
        cwd = _launch_cwd(tool, standalone=True)
        if cwd is None:
            return False
        if not await delivery.launch_tmux_session(tool.id, tool.id, command, cwd):
            push_status_error("delivery failed: new tmux session")
            return False
        deadline = time.monotonic() + 10.0
        while time.monotonic() < deadline:
            store.poll()
            for item in store.sessions_for_tool(tool.id):
                if item.id in known or not item.raw.get("tmux"):
                    continue
                store.apply_command({"cmd": "session.select", "id": item.id})
                ok = await delivery.deliver_text(item.raw, text, mode=_delivery_mode())
                if not ok:
                    push_status_error("delivery failed: replacement session")
                sync()
                return ok
            await asyncio.sleep(0.1)
        push_status_error("delivery failed: session start timeout")
        return False

    def deliver_message(text: str) -> None:
        """Queue-aware delivery shared by INPUT messages and transcripts.

        A busy (running/thinking) session queues instead of eating or
        dropping the message; the queue flushes FIFO when it goes idle.
        """
        rec = store.active()
        if _needs_delivery_handoff(rec):
            log.info("plain tty session %s: creating wrapped delivery session", rec.id)
            spawn(_handoff_to_wrapped_session(rec, text))
            return
        if rec is not None and rec.status.state == "running" and text:
            if len(send_queue) >= QUEUE_MAX:
                log.warning("send queue full; dropping oldest")
                send_queue.popleft()
            send_queue.append((rec.id, text))
            log.info("queued message for busy session %s (%d pending)", rec.id, len(send_queue))
            sync()  # STATUS now carries the queued count
            return
        spawn(_deliver_now(rec, text))

    def _delivery_hint(rec) -> str:
        """Precise failure reason for the STATUS error line."""
        raw = rec.raw if rec else {}
        if raw.get("tmux") or raw.get("zellij"):
            return "delivery failed"
        if not (raw.get("tty") or raw.get("pid")):
            return "delivery failed: no target (run CLI in tmux/zellij)"
        if not tiocsti_enabled:
            return "tty blocked by kernel; run CLI in tmux/zellij"
        return "delivery failed"

    async def _deliver_now(rec, text: str) -> bool:
        ok = await delivery.deliver_text(rec.raw if rec else None, text, mode=_delivery_mode())
        if not ok:
            push_status_error(_delivery_hint(rec))
        return ok

    async def _flush_queue() -> None:
        if flushing["active"]:
            return
        flushing["active"] = True
        try:
            while send_queue:
                rec = store.active()
                if rec is not None and rec.status.state == "running":
                    break  # busy again — keep pending
                sid, text = send_queue.popleft()
                target = store._record_for(sid)
                ok = await delivery.deliver_text(
                    target.raw if target else None, text, mode=_delivery_mode()
                )
                if not ok:
                    # no retry loop: drop and report once
                    push_status_error(_delivery_hint(target))
                if send_queue:
                    await asyncio.sleep(flush_interval)
        finally:
            flushing["active"] = False
            sync()

    def maybe_flush_queue() -> None:
        if not send_queue:
            return
        rec = store.active()
        if rec is None or rec.status.state != "running":
            spawn(_flush_queue())

    focused = yolo.FocusedInput()
    holder["voice_mode"] = "asr"

    async def deliver_yolo_text(text: str) -> None:
        if not await focused.text(text):
            push_status_error("YOLO input failed: install ydotool or wtype")

    async def deliver_yolo_enter() -> None:
        if not await focused.enter():
            push_status_error("YOLO Enter failed: focused input unavailable")

    async def deliver_yolo_escape() -> None:
        if not await focused.escape_twice():
            push_status_error("YOLO Escape failed: focused input unavailable")

    def deliver_transcript(text: str) -> None:
        if holder["voice_mode"] == "yolo":
            spawn(deliver_yolo_text(text))
        else:
            deliver_message(text)

    def push_status_error(text: str) -> None:
        """Ad-hoc STATUS state=error feedback (e.g. inference.cancel with no
        delivery target); overrides the store STATUS for a short TTL."""
        status = protocol.SessionStatus(
            tool=store.selected_tool or "",
            state="error",
            last=text,
            updated=int(time.time()),
        )
        holder["status_error"] = (status.to_json(), time.time())
        log.warning("%s", text)
        sync()

    pipeline = voice.VoicePipeline(
        cfg.asr, push=push_voice, deliver=deliver_transcript,
        transcription_log=voice.TranscriptionLog(),
    )
    relay = mic_mod.MicRelay(enabled=cfg.mic.enabled)
    holder["audio_route"] = routing.ASR
    spawn(relay.warmup())  # register "Vibe Mic" up-front

    def on_audio(data: bytes) -> None:
        # MIC-mode frames go to the virtual microphone only; ASR frames
        # go to the transcription pipeline only.
        if holder["audio_route"] == routing.MIC:
            relay.feed(data)
        else:
            pipeline.feed(data)

    def on_fn_activate(payload: dict) -> None:
        fn = str(payload.get("fn", ""))
        tool = store.selected_tool_config()
        if tool is None or fn not in tool.bindings:
            log.warning("fn.activate for unknown binding %r", fn)
            return
        rec = store.active()
        spawn(delivery.send_binding(rec.raw if rec else None, tool.bindings[fn]))

    def on_inference_cancel() -> None:
        """Send the cancel key (default Escape) to the selected session."""
        tool = store.selected_tool_config()
        binding = "escape"
        if tool is not None and tool.bindings.get("cancel"):
            binding = tool.bindings["cancel"]
        rec = store.active()

        async def do_cancel() -> None:
            ok = await delivery.send_binding(
                rec.raw if rec else None, binding, mode=_delivery_mode()
            )
            # A live /proc-only session can have a known pid but no usable
            # terminal transport: current Linux kernels reject TIOCSTI from a
            # background daemon.  An explicit Cancel may safely fall back to
            # SIGINT; text/voice delivery never uses this fallback.
            if not ok:
                ok = delivery.interrupt_process(rec.raw if rec else None)
            if not ok:
                push_status_error("cancel failed: " + _delivery_hint(rec))

        spawn(do_cancel())

    def on_session_new() -> None:
        """Start a fresh selected-tool session in the configured launcher."""
        tool = store.selected_tool_config()
        command = tool.launch_command() if tool is not None else ""
        tmux_target = store.tmux_target_for_selected()
        zellij_target = store.zellij_target_for_selected()
        if tool is None or not command:
            push_status_error("new session unsupported")
            return

        async def do_launch() -> None:
            launcher = holder["config"].session_launcher
            if launcher == "tmux":
                cwd = _launch_cwd(tool, standalone=not bool(tmux_target))
                ok = (cwd is not None and
                      (await delivery.launch_tmux_window(tmux_target, tool.id, command, cwd)
                       if tmux_target else
                       await delivery.launch_tmux_session(tool.id, tool.id, command, cwd)))
            elif launcher == "zellij":
                if not zellij_target:
                    push_status_error("new session: no zellij target")
                    return
                cwd = _launch_cwd(tool, standalone=False)
                ok = cwd is not None and await delivery.launch_zellij_pane(
                    zellij_target[0], tool.id, command, cwd)
            elif tmux_target:
                cwd = _launch_cwd(tool, standalone=False)
                ok = cwd is not None and await delivery.launch_tmux_window(
                    tmux_target, tool.id, command, cwd)
            elif zellij_target:
                cwd = _launch_cwd(tool, standalone=False)
                ok = cwd is not None and await delivery.launch_zellij_pane(
                    zellij_target[0], tool.id, command, cwd)
            else:
                cwd = _launch_cwd(tool, standalone=True)
                ok = cwd is not None and await delivery.launch_tmux_session(
                    tool.id, tool.id, command, cwd)
            if ok:
                store.request_new_session()
            else:
                push_status_error("new session failed")

        spawn(do_launch())

    def on_command(payload: dict) -> None:
        cmd = payload.get("cmd")
        if cmd == "owner.release":
            release_owner.set()
        elif cmd == protocol.CMD_FN_ACTIVATE:
            on_fn_activate(payload)
        elif cmd == protocol.CMD_INFERENCE_CANCEL:
            on_inference_cancel()
        elif cmd == protocol.CMD_SESSION_NEW:
            on_session_new()
        elif cmd == protocol.CMD_YOLO_ENTER:
            spawn(deliver_yolo_enter())
        elif cmd == protocol.CMD_YOLO_ESCAPE:
            spawn(deliver_yolo_escape())
        elif cmd in (protocol.CMD_VOICE_START, protocol.CMD_VOICE_STOP, protocol.CMD_VOICE_CANCEL):
            if cmd == protocol.CMD_VOICE_START:
                holder["voice_mode"] = "yolo" if payload.get("mode") == "yolo" else "asr"
            route_change = routing.transition(holder["audio_route"], cmd, payload.get("mode"))
            holder["audio_route"] = route_change.route
            for action in route_change.actions:
                if action == "relay.start":
                    spawn(relay.start())
                elif action == "relay.stop":
                    spawn(relay.stop())
                elif action == "asr.start":
                    pipeline.start()
                elif action == "asr.stop":
                    async def finish() -> None:
                        await pipeline.stop()
                        if holder["voice_mode"] == "yolo":
                            # YOLO sends immediately, but deliberately keeps
                            # VoicePipeline in ``ready``.  The Stick can then
                            # show the exact last transcription until the
                            # next hold-to-talk starts a new recording.
                            if pipeline.state == "ready" and pipeline.transcript:
                                await deliver_yolo_text(pipeline.transcript)
                            holder["voice_mode"] = "asr"
                    spawn(finish())
                elif action == "asr.cancel":
                    pipeline.cancel()
        elif cmd == protocol.CMD_VOICE_CONFIRM:
            pipeline.confirm()
        else:
            changed = store.apply_command(payload)
            if changed or cmd == protocol.CMD_REFRESH:
                sync()

    def get_payloads() -> tuple[str, str, str]:
        status = store.status_payload()
        override = holder.get("status_error")
        if override is not None:
            if time.time() - override[1] < STATUS_ERROR_TTL_SEC:
                status = override[0]
            else:
                holder["status_error"] = None
        elif send_queue:
            d = json.loads(status)
            d["queued"] = len(send_queue)
            status = json.dumps(d, ensure_ascii=False, separators=(",", ":"))
        return status, store.sessions_payload(), store.tools_payload()

    keyboard = VirtualKeyboard()
    keyboard.start()
    bridge = Bridge(
        transport, get_payloads, on_input, on_command,
        on_audio=on_audio, on_hid=keyboard.report,
    )
    holder["bridge"] = bridge

    def get_status() -> dict:
        """Runtime state for the dashboard (/api/status)."""
        pending: dict[str, int] = {}
        for sid, _text in send_queue:
            pending[sid] = pending.get(sid, 0) + 1
        return {
            **bridge.state(),
            # Expose the active implementation explicitly.  The TypeScript
            # desktop app is named "VibeStick Host 2.0"; this daemon remains
            # the supported Python 1.x implementation during the migration.
            "host_name": "VibeStick Host 1.x",
            "implementation": "python-1",
            "sessions": [
                {
                    "id": rec.id,
                    "tool": rec.status.tool,
                    "name": rec.status.session or rec.id,
                    "state": rec.status.state,
                }
                for rec in store.sessions()
            ],
            "tools": [
                {
                    "id": t.id,
                    "name": t.name,
                    "adapter": store.adapter_online(t.id),
                    "delivery": store.delivery_target_for(t.id),
                    "selected": t.id == store.selected_tool,
                    "sessions": [
                        {
                            "id": rec.id,
                            "name": rec.status.session or rec.id,
                            "state": rec.status.state,
                            "fg": store.fg_for(rec),
                            "tail": list(rec.status.tail),
                            "updated": rec.status.updated or int(rec.mtime),
                            "pending": pending.get(rec.id, 0),
                        }
                        for rec in store.sessions_for_tool(t.id)
                    ],
                }
                for t in store.visible_tools()
            ],
            "send_queue": [
                {"session": sid, "text": text[:60]} for sid, text in send_queue
            ],
            "tiocsti": tiocsti_enabled,
            "selected_tool": store.selected_tool,
            "config_path": str(config_path) if config_path else None,
            "uptime_sec": int(time.time() - started),
            "mic": {
                "enabled": relay.enabled,
                "active": relay.active,
            },
            "asr": {
                **voice.detect_asr_status(holder["config"].asr),
                "recent": pipeline.recent_transcriptions(),
            },
        }

    if runtime is not None:
        runtime["status"] = get_status
        runtime["command"] = on_command

    async def poll_loop() -> None:
        store.dir.mkdir(parents=True, exist_ok=True)
        last_presence = 0.0
        last_discovery = 0.0
        while True:
            try:
                changed = store.poll()
                now = time.time()
                if now - last_presence >= presence_interval:
                    last_presence = now
                    try:
                        if store.refresh_presence():
                            changed = True
                    except Exception as exc:  # noqa: BLE001 - presence is best-effort
                        log.warning("presence refresh failed: %s", exc)
                if now - last_discovery >= discovery_interval:
                    last_discovery = now
                    try:
                        if store.refresh_discovery():
                            changed = True
                    except Exception as exc:  # noqa: BLE001 - discovery is best-effort
                        log.warning("session discovery failed: %s", exc)
                reloaded = reload_config_if_changed(holder, store, pipeline, relay)
                if changed or reloaded:
                    await bridge.sync()
                maybe_flush_queue()
            except Exception:  # noqa: BLE001 - one bad iteration must never kill polling
                log.exception("poll loop iteration failed")
            await asyncio.sleep(poll_interval)

    poll_task = asyncio.ensure_future(poll_loop())
    bridge_task = asyncio.ensure_future(bridge.run())
    release_task = asyncio.ensure_future(release_owner.wait())
    try:
        done, _pending = await asyncio.wait(
            {bridge_task, release_task}, return_when=asyncio.FIRST_COMPLETED
        )
        if release_task in done:
            log.info("Python 1.x BLE owner released by explicit dashboard request")
            bridge_task.cancel()
            await asyncio.gather(bridge_task, return_exceptions=True)
        else:
            # Bridge.run normally reconnects indefinitely. Preserve a rare
            # unexpected exit rather than treating it as a successful handoff.
            await bridge_task
    finally:
        release_task.cancel()
        await asyncio.gather(release_task, return_exceptions=True)
        if not bridge_task.done():
            bridge_task.cancel()
            await asyncio.gather(bridge_task, return_exceptions=True)
        poll_task.cancel()
        await asyncio.gather(poll_task, return_exceptions=True)
        await background.cancel()
        keyboard.close()
        await relay.close()


def _mtime(path: Path | None) -> float | None:
    if path is None:
        return None
    try:
        return path.stat().st_mtime
    except OSError:
        return None


def reload_config_if_changed(
    holder: dict,
    store: SessionStore,
    pipeline: voice.VoicePipeline,
    relay: "mic_mod.MicRelay | None" = None,
) -> bool:
    """Pick up config edits (e.g. from the setup UI) by mtime. Sync-safe."""
    path = holder.get("config_path")
    if path is None:
        return False
    mtime = _mtime(path)
    if mtime is None or mtime == holder.get("config_mtime"):
        return False
    holder["config_mtime"] = mtime
    cfg = config_mod.load(path)
    holder["config"] = cfg
    pipeline.asr = cfg.asr
    if relay is not None:
        relay.enabled = cfg.mic.enabled
    store.set_config(cfg)
    log.info("config reloaded from %s", path)
    return True


def _acquire_singleton_lock(lock_path: Path | None = None) -> int | None:
    """Process-singleton flock; returns the held fd or None if taken.

    Two daemons (autostart + manual, vibestickd + vibestick-web spawn)
    fight over the BLE link and kick each other off the device. The lock
    file makes the second instance exit immediately with a clear log.
    """
    import fcntl

    path = lock_path or (Path.home() / ".vibestick" / "daemon.lock")
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        return None
    os.ftruncate(fd, 0)
    os.write(fd, str(os.getpid()).encode())
    return fd  # held until process exit (kernel releases the flock)


def main() -> None:
    parser = argparse.ArgumentParser(prog="vibestickd", description="VibeStick host daemon")
    parser.add_argument("--sessions-dir", default=None, help="override ~/.vibestick/sessions")
    parser.add_argument("--config", default=None, help="override ~/.vibestick/config.json")
    parser.add_argument("--setup", action="store_true",
                        help="serve the dashboard (default; kept for compatibility)")
    parser.add_argument("--no-dashboard", action="store_true", help="disable the dashboard web UI")
    parser.add_argument("--setup-port", type=int, default=setupui.DEFAULT_PORT, help="dashboard port (default 7860)")
    parser.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    lock_env = os.environ.get("VIBESTICK_LOCK_PATH")  # tests override
    lock_fd = _acquire_singleton_lock(Path(lock_env) if lock_env else None)
    if lock_fd is None:
        log.error("another vibestick daemon is already running; exiting")
        raise SystemExit(2)

    config_path = Path(args.config) if args.config else config_mod.DEFAULT_PATH
    cfg = config_mod.load(config_path)
    watcher = procwatch.ProcessWatcher()
    discovery = discover.SessionDiscovery()
    if args.sessions_dir:
        store = SessionStore(args.sessions_dir, config=cfg, watcher=watcher, discovery=discovery)
    else:
        store = SessionStore(config=cfg, watcher=watcher, discovery=discovery)

    runtime: dict = {}

    def status_provider() -> dict:
        get_status = runtime.get("status")
        if get_status is not None:
            return get_status()
        return {
            "connected": False,
            "device_address": None,
            "connected_since": None,
            "last_sync": None,
            "sessions": [],
            "selected_tool": store.selected_tool,
            "config_path": str(config_path),
            "uptime_sec": 0,
        }

    if not args.no_dashboard:
        def command_handler(cmd: dict) -> None:
            handler = runtime.get("command")
            loop = runtime.get("loop")
            if handler is None or loop is None:
                raise RuntimeError("daemon not ready")
            # The dashboard is served by ThreadingHTTPServer.  All daemon
            # callbacks create asyncio work, so schedule the command back on
            # the owning loop instead of calling it in the HTTP thread.
            loop.call_soon_threadsafe(handler, cmd)

        try:
            server, _ = setupui.serve_in_thread(
                config_path, port=args.setup_port,
                status_provider=status_provider,
                command_handler=command_handler,
            )
            log.info("dashboard: http://127.0.0.1:%d", server.server_address[1])
        except OSError as exc:
            log.warning("dashboard unavailable on port %d: %s", args.setup_port, exc)

    transport = BleakTransport()
    try:
        asyncio.run(run_daemon(store, transport, cfg, config_path=config_path, runtime=runtime))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
