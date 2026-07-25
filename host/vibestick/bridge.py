"""BLE central: connects to the VibeStick device and syncs payloads.

The BLE transport lives behind the `Transport` protocol so tests (or a
development machine without BLE) can swap in a fake.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Callable, Protocol

from . import protocol

log = logging.getLogger(__name__)

BACKOFF_INITIAL_SEC = 1.0
BACKOFF_MAX_SEC = 30.0

NotifyCallback = Callable[[str, bytes], None]  # (characteristic name, payload)
AudioCallback = Callable[[bytes], None]


class Transport(Protocol):
    """Minimal BLE-central interface used by the bridge."""

    async def connect(self) -> None:
        """Find the VibeStick device, connect, subscribe to INPUT/COMMAND/AUDIO."""
        ...

    async def disconnect(self) -> None: ...

    def is_connected(self) -> bool: ...

    async def write_status(self, payload: bytes) -> None: ...

    async def write_sessions(self, payload: bytes) -> None: ...

    async def write_tools(self, payload: bytes) -> None: ...

    async def write_voice(self, payload: bytes) -> None: ...

    def set_notify_handler(self, handler: NotifyCallback) -> None: ...


class BleakTransport:
    """Real transport backed by bleak."""

    def __init__(self) -> None:
        self._client = None  # bleak.BleakClient, imported lazily
        self._handler: NotifyCallback | None = None
        self.address: str | None = None  # device address while connected

    def is_connected(self) -> bool:
        return self._client is not None and self._client.is_connected

    def set_notify_handler(self, handler: NotifyCallback) -> None:
        self._handler = handler

    async def connect(self) -> None:
        from bleak import BleakClient, BleakScanner

        log.info("scanning for %r ...", protocol.DEVICE_NAME)
        device = await BleakScanner.find_device_by_name(protocol.DEVICE_NAME, timeout=15.0)
        if device is None:
            raise ConnectionError(f"device {protocol.DEVICE_NAME!r} not found")
        client = BleakClient(device, disconnected_callback=self._on_disconnect)
        await client.connect()
        self._client = client
        self.address = str(device.address)
        for name, uuid in (
            ("INPUT", protocol.INPUT_UUID),
            ("COMMAND", protocol.COMMAND_UUID),
            ("AUDIO", protocol.AUDIO_UUID),
        ):
            await client.start_notify(uuid, self._make_notify_cb(name))
        log.info("connected to %s", device.address)

    async def disconnect(self) -> None:
        if self._client is not None:
            try:
                await self._client.disconnect()
            except Exception:  # noqa: BLE001 - best effort cleanup
                pass
            self._client = None
        self.address = None

    # Writes use response=True so BlueZ falls back to the long-write
    # procedure when a payload exceeds MTU-3 (244 B) — TOOLS/SESSIONS
    # legitimately grow past that with several tools/sessions.
    async def _write(self, uuid: str, payload: bytes) -> None:
        client = self._client
        if client is None:
            raise ConnectionError("BLE client disconnected")
        await client.write_gatt_char(uuid, payload, response=True)

    async def write_status(self, payload: bytes) -> None:
        await self._write(protocol.STATUS_UUID, payload)

    async def write_sessions(self, payload: bytes) -> None:
        await self._write(protocol.SESSIONS_UUID, payload)

    async def write_tools(self, payload: bytes) -> None:
        await self._write(protocol.TOOLS_UUID, payload)

    async def write_voice(self, payload: bytes) -> None:
        await self._write(protocol.VOICE_UUID, payload)

    def _make_notify_cb(self, name: str):
        def cb(_sender, data: bytearray) -> None:
            if self._handler is not None:
                self._handler(name, bytes(data))

        return cb

    def _on_disconnect(self, _client) -> None:
        log.info("device disconnected")


class Bridge:
    """Keeps a Transport connected and pushes STATUS/SESSIONS/TOOLS on change.

    `get_payloads` returns (status_json, sessions_json, tools_json);
    `on_input`/`on_command` handle device JSON notifications; `on_audio`
    receives raw binary AUDIO frames. Runs forever until cancelled.
    """

    def __init__(
        self,
        transport: Transport,
        get_payloads: Callable[[], tuple[str, str, str]],
        on_input: Callable[[dict], None],
        on_command: Callable[[dict], None],
        on_audio: AudioCallback | None = None,
    ) -> None:
        self.transport = transport
        self._get_payloads = get_payloads
        self._on_input = on_input
        self._on_command = on_command
        self._on_audio = on_audio
        self._last: dict[str, str | None] = {"status": None, "sessions": None, "tools": None}
        self.connected_since: float | None = None  # epoch of current connection
        self.last_sync: float | None = None  # epoch of last payload write
        transport.set_notify_handler(self._handle_notify)

    def state(self) -> dict:
        """Connection state for the dashboard (/api/status)."""
        return {
            "connected": self.transport.is_connected(),
            "device_address": getattr(self.transport, "address", None),
            "connected_since": self.connected_since if self.transport.is_connected() else None,
            "last_sync": self.last_sync,
        }

    async def run(self) -> None:
        backoff = BACKOFF_INITIAL_SEC
        while True:
            try:
                await self.transport.connect()
                self.connected_since = time.time()
                backoff = BACKOFF_INITIAL_SEC
                await self.sync(force=True)
                await self._connected_loop()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - reconnect on anything
                log.warning("BLE error: %s; reconnecting in %.0fs", exc, backoff)
            finally:
                try:
                    await self.transport.disconnect()
                except Exception:  # noqa: BLE001
                    pass
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, BACKOFF_MAX_SEC)

    async def _connected_loop(self) -> None:
        while self.transport.is_connected():
            await self.sync()
            await asyncio.sleep(0.5)

    async def sync(self, force: bool = False) -> None:
        """Write STATUS/SESSIONS/TOOLS if changed (or forced, e.g. on connect)."""
        if not self.transport.is_connected():
            return  # nothing to write to; callers poll sync() unconditionally
        status, sessions, tools = self._get_payloads()
        for name, payload, writer in (
            ("status", status, self.transport.write_status),
            ("sessions", sessions, self.transport.write_sessions),
            ("tools", tools, self.transport.write_tools),
        ):
            if force or payload != self._last[name]:
                await writer(payload.encode("utf-8"))
                self._last[name] = payload
        self.last_sync = time.time()

    async def push_voice(self, voice_json: str) -> None:
        """Push a VOICE payload immediately (not change-deduped)."""
        if not self.transport.is_connected():
            return
        try:
            await self.transport.write_voice(voice_json.encode("utf-8"))
        except Exception as exc:  # noqa: BLE001 - voice state is best-effort
            log.warning("VOICE write failed: %s", exc)

    def _handle_notify(self, name: str, data: bytes) -> None:
        if name == "AUDIO":
            if self._on_audio is not None:
                self._on_audio(data)
            return
        try:
            payload = json.loads(data.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            log.warning("bad %s payload ignored: %s", name, exc)
            return
        if name == "INPUT":
            self._on_input(payload)
        elif name == "COMMAND":
            self._on_command(payload)
