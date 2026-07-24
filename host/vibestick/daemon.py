"""Asyncio daemon: polls the session store and drives the BLE bridge.

Run as `python -m vibestick.daemon` or via the `vibestickd` script.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import time
from collections import deque
from pathlib import Path

from . import config as config_mod
from . import delivery, discover, mic as mic_mod, procwatch, protocol, setupui, voice
from .bridge import BleakTransport, Bridge, Transport
from .store import POLL_INTERVAL_SEC, SessionStore

log = logging.getLogger(__name__)

PRESENCE_INTERVAL_SEC = 5.0  # cheap /proc scan cadence
DISCOVERY_INTERVAL_SEC = 10.0  # CLI on-disk session store scan cadence
STATUS_ERROR_TTL_SEC = 10.0  # how long an ad-hoc error STATUS overrides the store
QUEUE_MAX = 8  # per-session send queue cap (oldest dropped beyond this)
FLUSH_INTERVAL_SEC = 0.3  # spacing between queued deliveries


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
    tiocsti_enabled = delivery._legacy_tiocsti() == "1"
    if not tiocsti_enabled:
        log.warning(
            "TIOCSTI is disabled on this kernel (dev.tty.legacy_tiocsti=0); "
            "tty delivery will fail — run: sudo sysctl dev.tty.legacy_tiocsti=1"
        )
    holder: dict = {
        "bridge": None,
        "config": cfg,
        "config_path": config_path,
        "config_mtime": _mtime(config_path),
    }

    def _delivery_mode() -> str:
        tool = store.selected_tool_config()
        return tool.delivery if tool is not None else "auto"

    def on_input(payload: dict) -> None:
        if payload.get("type") == protocol.INPUT_MESSAGE:
            deliver_message(str(payload.get("text", "")))
        elif payload.get("type") == protocol.INPUT_KEY:
            # Keys other than mapped commands are handled on-device; log only.
            log.info("key input: %r", payload.get("key"))

    def sync() -> None:
        bridge = holder["bridge"]
        if bridge is not None:
            asyncio.ensure_future(bridge.sync(force=True))

    def push_voice(voice_json: str) -> None:
        bridge = holder["bridge"]
        if bridge is not None:
            asyncio.ensure_future(bridge.push_voice(voice_json))

    # -- per-session send queue ---------------------------------------------

    send_queue: deque[tuple[str, str]] = deque()  # (session_id, text), FIFO
    flushing = {"active": False}

    def deliver_message(text: str) -> None:
        """Queue-aware delivery shared by INPUT messages and transcripts.

        A busy (running/thinking) session queues instead of eating or
        dropping the message; the queue flushes FIFO when it goes idle.
        """
        rec = store.active()
        if rec is not None and rec.status.state == "running" and text:
            if len(send_queue) >= QUEUE_MAX:
                log.warning("send queue full; dropping oldest")
                send_queue.popleft()
            send_queue.append((rec.id, text))
            log.info("queued message for busy session %s (%d pending)", rec.id, len(send_queue))
            sync()  # STATUS now carries the queued count
            return
        asyncio.ensure_future(_deliver_now(rec, text))

    async def _deliver_now(rec, text: str) -> bool:
        ok = await delivery.deliver_text(rec.raw if rec else None, text, mode=_delivery_mode())
        if not ok:
            push_status_error("delivery failed: no target")
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
                    push_status_error("delivery failed: no target")
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
            asyncio.ensure_future(_flush_queue())

    def deliver_transcript(text: str) -> None:
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
    holder["audio_route"] = None  # "mic" during a PTT mic session, else None
    asyncio.ensure_future(relay.warmup())  # register "VibeStick Mic" up-front

    def on_audio(data: bytes) -> None:
        # MIC-mode frames go to the virtual microphone only; ASR frames
        # go to the transcription pipeline only.
        if holder["audio_route"] == "mic":
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
        asyncio.ensure_future(delivery.send_binding(rec.raw if rec else None, tool.bindings[fn]))

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
            if not ok:
                push_status_error("cancel failed: no delivery target")

        asyncio.ensure_future(do_cancel())

    def on_session_new() -> None:
        """Start a fresh session of the selected tool in a new tmux window."""
        tool = store.selected_tool_config()
        command = tool.launch_command() if tool is not None else ""
        target = store.tmux_target_for_selected()
        if tool is None or not command or not target:
            push_status_error("new session unsupported")
            return

        async def do_launch() -> None:
            ok = await delivery.launch_tmux_window(target, tool.id, command)
            if ok:
                store.request_new_session()
            else:
                push_status_error("new session failed")

        asyncio.ensure_future(do_launch())

    def on_command(payload: dict) -> None:
        cmd = payload.get("cmd")
        if cmd == protocol.CMD_FN_ACTIVATE:
            on_fn_activate(payload)
        elif cmd == protocol.CMD_INFERENCE_CANCEL:
            on_inference_cancel()
        elif cmd == protocol.CMD_SESSION_NEW:
            on_session_new()
        elif cmd == protocol.CMD_VOICE_START:
            if payload.get("mode") == "mic":
                holder["audio_route"] = "mic"
                asyncio.ensure_future(relay.start())
            else:
                pipeline.start()
        elif cmd == protocol.CMD_VOICE_STOP:
            if holder["audio_route"] == "mic":
                holder["audio_route"] = None
                asyncio.ensure_future(relay.stop())
            else:
                asyncio.ensure_future(pipeline.stop())
        elif cmd == protocol.CMD_VOICE_CONFIRM:
            pipeline.confirm()
        elif cmd == protocol.CMD_VOICE_CANCEL:
            pipeline.cancel()
            if holder["audio_route"] == "mic":
                holder["audio_route"] = None
                asyncio.ensure_future(relay.stop())
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

    bridge = Bridge(transport, get_payloads, on_input, on_command, on_audio=on_audio)
    holder["bridge"] = bridge

    def get_status() -> dict:
        """Runtime state for the dashboard (/api/status)."""
        pending: dict[str, int] = {}
        for sid, _text in send_queue:
            pending[sid] = pending.get(sid, 0) + 1
        return {
            **bridge.state(),
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
            await asyncio.sleep(poll_interval)

    poll_task = asyncio.ensure_future(poll_loop())
    try:
        await bridge.run()
    finally:
        poll_task.cancel()
        await asyncio.gather(poll_task, return_exceptions=True)
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
            if handler is None:
                raise RuntimeError("daemon not ready")
            handler(cmd)

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
