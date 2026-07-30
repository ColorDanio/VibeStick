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
import subprocess
import sys
import re
from pathlib import Path

from vibestick import protocol
from vibestick.hid import VirtualKeyboard
from vibestick.mic import MicRelay
from vibestick import delivery, yolo

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
    "DEVICE_CONFIG": protocol.DEVICE_CONFIG_UUID,
}


def emit(payload: dict) -> None:
    print(json.dumps(payload, separators=(",", ":")), flush=True)


class Helper:
    def __init__(self) -> None:
        self.client = None
        self.lock_fd: int | None = None
        self.mic = MicRelay()
        self.keyboard = VirtualKeyboard()
        self.focused = yolo.FocusedInput()

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
                devices = await self.scan()
                candidate = next((item for item in devices if item["name"].startswith("VibeStick_")), None)
                if candidate is None:
                    raise ConnectionError("VibeStick not found")
                client = BleakClient(candidate["address"], disconnected_callback=self._disconnected)
                await client.connect()
        except Exception:
            self._release_owner()
            raise
        self.client = client
        actual = str(client.address)
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        CACHE.write_text(actual + "\n")
        for name, uuid in NOTIFY.items():
            try:
                await client.start_notify(uuid, self._notify(name))
            except Exception:
                # BlueZ can auto-own the standard HID input report for its
                # keyboard integration and reject a second application
                # subscription. The GATT command/audio bridge remains fully
                # usable, so do not turn that optional fallback into a
                # connection failure.
                if name != "HID_INPUT":
                    raise
        return actual

    async def scan(self) -> list[dict]:
        """Return nearby VibeStick boards; scanning never opens a second GATT link."""
        from bleak import BleakScanner
        found = await BleakScanner.discover(timeout=5.0)
        devices: dict[str, dict] = {}
        for device in found:
            name = str(getattr(device, "name", "") or "")
            if not name.startswith("VibeStick_"):
                continue
            address = str(getattr(device, "address", "") or "")
            if address:
                devices[address.upper()] = {"name": name, "address": address.upper(), "rssi": getattr(device, "rssi", None), "paired": False, "connected": address.upper() == str(getattr(self.client, "address", "")).upper()}
        # BlueZ keeps paired devices even when they are not advertising. Merge
        # them so Settings can manage a remembered Stick rather than exposing
        # only the few seconds in which it happens to be discoverable.
        try:
            output = subprocess.run(["bluetoothctl", "devices", "Paired"], capture_output=True, text=True, timeout=3, check=False).stdout
            for line in output.splitlines():
                parts = line.split(maxsplit=2)
                if len(parts) != 3 or parts[0] != "Device" or not parts[2].startswith("VibeStick_"):
                    continue
                address, name = parts[1].upper(), parts[2]
                item = devices.setdefault(address, {"name": name, "address": address, "rssi": None, "paired": True, "connected": False})
                item["paired"] = True
                item["connected"] = address == str(getattr(self.client, "address", "")).upper()
        except (OSError, subprocess.SubprocessError):
            pass
        return sorted(devices.values(), key=lambda item: item["name"])

    async def pair(self, address: str) -> None:
        self._validate_address(address)
        output = await self._bluetoothctl(f"pair {address}", timeout=25)
        if "Paired: yes" not in output and "successful" not in output.lower():
            raise RuntimeError(output.strip() or "Bluetooth pairing failed")
        await self._bluetoothctl(f"trust {address}", timeout=5)

    async def unpair(self, address: str) -> None:
        self._validate_address(address)
        if self.client is not None and str(self.client.address).upper() == address.upper():
            await self.disconnect()
        output = await self._bluetoothctl(f"remove {address}", timeout=8)
        if "not available" in output.lower() or "failed" in output.lower():
            raise RuntimeError(output.strip() or "Bluetooth unpair failed")
        if self._cached().upper() == address.upper():
            try:
                CACHE.unlink()
            except FileNotFoundError:
                pass

    @staticmethod
    def _validate_address(address: str) -> None:
        if not re.fullmatch(r"(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}", address):
            raise ValueError("invalid Bluetooth address")

    @staticmethod
    async def _bluetoothctl(command: str, timeout: int) -> str:
        result = await asyncio.to_thread(subprocess.run, ["bluetoothctl", "--timeout", str(timeout), *command.split()], capture_output=True, text=True, timeout=timeout + 3, check=False)
        return result.stdout + result.stderr

    async def disconnect(self) -> None:
        try:
            if self.client is not None:
                await self.client.disconnect()
        finally:
            self.client = None
            await self.mic.stop()
            self.keyboard.close()
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

    async def new_session(self, request: dict) -> bool:
        """Launch a monitored CLI session; policy comes from TypeScript."""
        tool_id = str(request.get("tool") or "")
        name = str(request.get("name") or tool_id)
        command = str(request.get("command") or "")
        cwd = str(request.get("cwd") or "")
        launcher = str(request.get("launcher") or "auto")
        record = request.get("record") if isinstance(request.get("record"), dict) else {}
        tmux = str(record.get("tmux") or "")
        zellij = str(record.get("zellij") or "")
        if not command or not tool_id:
            return False
        if launcher == "tmux":
            return await (delivery.launch_tmux_window(tmux, name, command, cwd) if tmux
                          else delivery.launch_tmux_session(tool_id, name, command, cwd or str(Path.home())))
        if launcher == "zellij":
            return await delivery.launch_zellij_pane(zellij, name, command, cwd) if zellij else False
        if tmux:
            return await delivery.launch_tmux_window(tmux, name, command, cwd)
        if zellij:
            return await delivery.launch_zellij_pane(zellij, name, command, cwd)
        return await delivery.launch_tmux_session(tool_id, name, command, cwd or str(Path.home()))


async def main() -> None:
    helper = Helper()
    while line := await asyncio.to_thread(sys.stdin.readline):
        try:
            request = json.loads(line)
            ident, command = request["id"], request["cmd"]
            if command == "connect":
                result = {"address": await helper.connect(str(request.get("address") or ""))}
            elif command == "scan":
                result = {"devices": await helper.scan()}
            elif command == "pair":
                await helper.pair(str(request.get("address") or "")); result = {}
            elif command == "unpair":
                await helper.unpair(str(request.get("address") or "")); result = {}
            elif command == "disconnect":
                await helper.disconnect(); result = {}
            elif command == "write":
                await helper.write(str(request["characteristic"]), str(request["data"])); result = {}
            elif command == "mic.warmup":
                result = {"available": await helper.mic.warmup()}
            elif command == "mic.select":
                result = {"available": await helper.mic.select()}
            elif command == "mic.restore":
                await helper.mic.restore(); result = {}
            elif command == "mic.start":
                result = {"available": await helper.mic.start()}
            elif command == "mic.feed":
                helper.mic.feed(base64.b64decode(str(request["data"]))); result = {}
            elif command == "mic.stop":
                await helper.mic.stop(); result = {}
            elif command == "hid.report":
                helper.keyboard.report(base64.b64decode(str(request["data"]))); result = {}
            elif command == "delivery.text":
                raw = request.get("record")
                result = {"delivered": await delivery.deliver_text(raw if isinstance(raw, dict) else None, str(request.get("text") or ""))}
            elif command == "delivery.binding":
                raw = request.get("record")
                result = {"delivered": await delivery.send_binding(raw if isinstance(raw, dict) else None, str(request.get("binding") or ""))}
            elif command == "focused.text":
                result = {"delivered": await helper.focused.text(str(request.get("text") or ""))}
            elif command == "focused.probe":
                # This is deliberately a side-effect-free capability check.
                # The TypeScript owner calls it only after it owns the BLE
                # link, so standby Host 2.0 never advertises a false-ready
                # YOLO route while Python 1.x owns the device.
                result = {"available": helper.focused.available}
            elif command == "focused.enter":
                result = {"delivered": await helper.focused.enter()}
            elif command == "focused.escape":
                result = {"delivered": await helper.focused.escape_twice()}
            elif command == "session.new":
                result = {"delivered": await helper.new_session(request)}
            else:
                raise ValueError("unknown command")
            emit({"id": ident, "ok": True, "result": result})
        except Exception as exc:  # helper errors become structured TS capability errors
            emit({"id": request.get("id") if "request" in locals() else None, "ok": False, "error": str(exc)})


if __name__ == "__main__":
    asyncio.run(main())
