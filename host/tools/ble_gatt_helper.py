#!/usr/bin/env python3
"""JSON-lines BLE GATT helper for the TypeScript host.

The helper deliberately owns only platform BLE operations.  Domain decisions
(sessions, routing, ASR and Vibe Mic policy) stay in TypeScript.  It uses the
same stable Bleak/BlueZ path as the Python traditional daemon.
"""
from __future__ import annotations

import asyncio
import base64
import fcntl
import json
import os
import sys
from pathlib import Path

from vibestick import protocol

CACHE = Path.home() / ".vibestick" / "device-address"
LOCK = Path.home() / ".vibestick" / "daemon.lock"
NOTIFY = {
    "INPUT": protocol.INPUT_UUID,
    "COMMAND": protocol.COMMAND_UUID,
    "AUDIO": protocol.AUDIO_UUID,
    "HID_INPUT": protocol.HID_INPUT_UUID,
}
WRITE = {
    "STATUS": protocol.STATUS_UUID,
    "SESSIONS": protocol.SESSIONS_UUID,
    "TOOLS": protocol.TOOLS_UUID,
    "VOICE": protocol.VOICE_UUID,
}


def emit(payload: dict) -> None:
    print(json.dumps(payload, separators=(",", ":")), flush=True)


class Helper:
    def __init__(self) -> None:
        self.client = None
        self.lock_fd: int | None = None

    async def connect(self, address: str = "") -> str:
        from bleak import BleakClient, BleakScanner
        self._acquire_owner()
        target = address or self._cached()
        client = None
        if target:
            try:
                client = BleakClient(target, disconnected_callback=self._disconnected)
                await client.connect()
            except Exception:
                client = None
        try:
            if client is None:
                device = await BleakScanner.find_device_by_name(protocol.DEVICE_NAME, timeout=15.0)
                if device is None:
                    raise ConnectionError("VibeStick not found")
                client = BleakClient(device, disconnected_callback=self._disconnected)
                await client.connect()
        except Exception:
            self._release_owner()
            raise
        self.client = client
        actual = str(client.address)
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        CACHE.write_text(actual + "\n")
        for name, uuid in NOTIFY.items():
            await client.start_notify(uuid, self._notify(name))
        return actual

    async def disconnect(self) -> None:
        try:
            if self.client is not None:
                await self.client.disconnect()
        finally:
            self.client = None
            self._release_owner()

    def _acquire_owner(self) -> None:
        if self.lock_fd is not None:
            return
        LOCK.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(LOCK, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            os.close(fd)
            raise RuntimeError("VibeStick already owned by vibestickd; stop it before TS host") from exc
        self.lock_fd = fd

    def _release_owner(self) -> None:
        if self.lock_fd is not None:
            os.close(self.lock_fd)
            self.lock_fd = None

    async def write(self, name: str, data: str) -> None:
        if self.client is None:
            raise ConnectionError("not connected")
        await self.client.write_gatt_char(WRITE[name], base64.b64decode(data), response=True)

    def _cached(self) -> str:
        try:
            return CACHE.read_text().strip()
        except OSError:
            return ""

    def _notify(self, name: str):
        def callback(_sender, data: bytearray) -> None:
            emit({"event": "notify", "characteristic": name,
                  "data": base64.b64encode(bytes(data)).decode()})
        return callback

    def _disconnected(self, _client) -> None:
        self.client = None
        self._release_owner()
        emit({"event": "disconnected"})


async def main() -> None:
    helper = Helper()
    while line := await asyncio.to_thread(sys.stdin.readline):
        try:
            request = json.loads(line)
            ident, command = request["id"], request["cmd"]
            if command == "connect":
                result = {"address": await helper.connect(str(request.get("address") or ""))}
            elif command == "disconnect":
                await helper.disconnect(); result = {}
            elif command == "write":
                await helper.write(str(request["characteristic"]), str(request["data"])); result = {}
            else:
                raise ValueError("unknown command")
            emit({"id": ident, "ok": True, "result": result})
        except Exception as exc:  # helper errors become structured TS capability errors
            emit({"id": request.get("id") if "request" in locals() else None, "ok": False, "error": str(exc)})


if __name__ == "__main__":
    asyncio.run(main())
