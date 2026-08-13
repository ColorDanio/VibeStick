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
    "USAGE": protocol.USAGE_UUID,
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
        from bleak import BleakClient
        self._acquire_owner()
        target = address or self._cached()
        if not target:
            self._release_owner()
            raise ConnectionError("No VibeStick selected. Choose one in Device Setup first.")
        self._validate_address(target)
        client = None
        try:
            client = BleakClient(target, timeout=20.0, disconnected_callback=self._disconnected)
            await asyncio.wait_for(client.connect(), timeout=25.0)
        except Exception:
            try:
                if client is not None and client.is_connected:
                    await client.disconnect()
            finally:
                self._release_owner()
            raise
        self.client = client
        actual = str(client.address)
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        CACHE.write_text(actual + "\n")
        try:
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
        except Exception:
            try:
                if client.is_connected:
                    await client.disconnect()
            finally:
                self.client = None
                self._release_owner()
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
        for paired in await self.paired():
            address = paired["address"]
            item = devices.setdefault(address, paired)
            item["paired"] = True
            item["connected"] = bool(paired["connected"])
        return sorted(devices.values(), key=lambda item: item["name"])

    async def paired(self) -> list[dict]:
        """Return remembered Sticks immediately; this never starts a BLE scan."""
        try:
            output = await asyncio.to_thread(
                subprocess.run, ["bluetoothctl", "devices", "Paired"],
                capture_output=True, text=True, timeout=3, check=False,
            )
        except (OSError, subprocess.SubprocessError):
            return []
        active = str(getattr(self.client, "address", "")).upper()
        devices: list[dict] = []
        for line in output.stdout.splitlines():
            parts = line.split(maxsplit=2)
            if len(parts) != 3 or parts[0] != "Device" or not parts[2].startswith("VibeStick_"):
                continue
            address, name = parts[1].upper(), parts[2]
            # ``bluetoothctl devices Paired`` can briefly retain a stale line
            # after remove. Confirm the actual BlueZ bond before exposing it
            # to the UI, otherwise an already removed Stick reappears.
            if not await self._is_paired(address):
                continue
            devices.append({"name": name, "address": address, "rssi": None, "paired": True, "connected": address == active})
        return sorted(devices, key=lambda item: item["name"])

    async def pair(self, address: str) -> None:
        """Pair through the BlueZ D-Bus path used by Bleak, not an ephemeral CLI agent.

        Bleak's ``pair=True`` keeps pairing and the GATT connection in the same
        BlueZ operation. BlueZ still requires an Agent1 implementation for the
        HID security request, even for a no-input/no-output Just Works device;
        the temporary bluetoothctl agent below supplies that contract for the
        duration of the operation.
        """
        from bleak import BleakClient
        self._validate_address(address)
        if self.client is not None:
            raise RuntimeError("Disconnect the active VibeStick before pairing another one")
        self._acquire_owner()
        client = None
        pairing_agent = None
        try:
            # Register the agent before touching the existing HID link.  BlueZ
            # can trigger authentication while disconnecting an automatically
            # connected HID profile; if no Agent1 is registered at that point,
            # the controller reports ``No agent available`` and the subsequent
            # Pair call degenerates into a page timeout.
            pairing_agent = await self._start_pairing_agent()
            # A previously failed attempt can leave an unpaired device marked
            # Trusted. BlueZ then lets the HID profile reconnect immediately,
            # racing the new Pair call. An unpaired device has no bond to
            # preserve, so clear that stale auto-connect policy before retrying.
            if not await self._is_paired(address):
                await self._bluetoothctl(f"untrust {address}", timeout=8)
            # A HID profile can leave a stale BlueZ connection while the GATT
            # object reports disconnected. Release that link before asking
            # BlueZ to pair, otherwise the Pair call often ends in Page Timeout.
            await self._bluetoothctl(f"disconnect {address}", timeout=8)
            client = BleakClient(address, pair=True, timeout=25.0)
            await asyncio.wait_for(client.connect(), timeout=30.0)
        except asyncio.TimeoutError as exc:
            raise RuntimeError("Pairing timed out. Put the Stick next to this computer and try again.") from exc
        except Exception as exc:
            raise RuntimeError(f"Bluetooth pairing failed: {exc}") from exc
        finally:
            try:
                if client is not None and client.is_connected:
                    await client.disconnect()
            finally:
                if pairing_agent is not None:
                    await self._stop_pairing_agent(pairing_agent)
                self._release_owner()

        # BlueZ releases the temporary pairing GATT object asynchronously. A
        # short settle period prevents the immediately-following activation
        # connection from racing that teardown and leaving the helper without
        # an observable owner.
        await asyncio.sleep(0.25)

        # Trust is persistent policy rather than an interactive pairing step;
        # bluetoothctl is reliable for it and is available on all supported
        # Linux BlueZ installations.
        output = await self._bluetoothctl(f"trust {address}", timeout=8)
        if "failed" in output.lower():
            raise RuntimeError(output.strip() or "Bluetooth paired but could not be trusted")

    async def _start_pairing_agent(self):
        """Keep a no-input/no-output BlueZ agent alive while Pair runs.

        A one-shot ``bluetoothctl agent`` command exits before BlueZ asks for
        confirmation. Keeping the command interpreter open avoids that race,
        while the reader task prevents its status output from filling a pipe.
        """
        try:
            process = await asyncio.create_subprocess_exec(
                "bluetoothctl", "--agent", "NoInputNoOutput",
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
        except (OSError, asyncio.SubprocessError) as exc:
            raise RuntimeError(f"Could not start Bluetooth pairing agent: {exc}") from exc

        # `bluetoothctl --agent` registers the agent as part of startup on
        # current BlueZ releases. Some versions print
        # ``Default agent request successful`` after the explicit command,
        # while others only print ``Agent registered`` (and leave the
        # default-agent command silent). Waiting for just the former caused
        # us to tear down a valid agent after five seconds, so BlueZ later
        # reported ``No agent available`` and Bleak surfaced Page Timeout.
        agent_ready = asyncio.Event()
        messages: list[str] = []

        async def consume() -> None:
            if process.stdout is None:
                return
            while line := await process.stdout.readline():
                text = line.decode(errors="replace").strip()
                if text:
                    messages.append(text)
                if (
                    "Agent registered" in text
                    or "Agent is already registered" in text
                    or "Default agent request successful" in text
                ):
                    agent_ready.set()

        reader = asyncio.create_task(consume())
        try:
            if process.stdin is None:
                raise RuntimeError("Bluetooth pairing agent has no command pipe")
            process.stdin.write(b"default-agent\n")
            await process.stdin.drain()
            await asyncio.wait_for(agent_ready.wait(), timeout=5.0)
        except Exception as exc:
            await self._stop_pairing_agent((process, reader))
            detail = messages[-1] if messages else str(exc)
            raise RuntimeError(f"Bluetooth pairing agent was not available: {detail}") from exc
        return process, reader

    @staticmethod
    async def _stop_pairing_agent(agent) -> None:
        process, reader = agent
        try:
            if process.stdin is not None and process.returncode is None:
                process.stdin.write(b"quit\n")
                await process.stdin.drain()
                process.stdin.close()
            await asyncio.wait_for(process.wait(), timeout=3.0)
        except (OSError, asyncio.TimeoutError, asyncio.CancelledError):
            if process.returncode is None:
                process.kill()
                await process.wait()
        finally:
            reader.cancel()
            await asyncio.gather(reader, return_exceptions=True)

    async def unpair(self, address: str) -> None:
        self._validate_address(address)
        if self.client is not None and str(self.client.address).upper() == address.upper():
            await self.disconnect()
        # BlueZ may keep the HID keyboard link alive even after the app's GATT
        # helper disconnects. Removing a bond beneath that connection leaves
        # a stale device object which prevents a later Pair & Use. Tear down
        # every link first, then remove the remembered pairing.
        await self._bluetoothctl(f"disconnect {address}", timeout=8)
        output = await self._bluetoothctl(f"remove {address}", timeout=8)
        if "failed" in output.lower() and "not available" not in output.lower():
            raise RuntimeError(output.strip() or "Bluetooth unpair failed")
        # BlueZ processes remove asynchronously. Verify the bond is really
        # gone, retrying a few times for the HID/GATT device object to settle.
        for attempt in range(5):
            if not await self._is_paired(address):
                break
            if attempt == 4:
                raise RuntimeError("Bluetooth still reports this Stick as paired")
            await asyncio.sleep(0.35)
            retry = await self._bluetoothctl(f"remove {address}", timeout=8)
            if "failed" in retry.lower() and "not available" not in retry.lower():
                raise RuntimeError(retry.strip() or "Bluetooth unpair failed")
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

    @classmethod
    async def _is_paired(cls, address: str) -> bool:
        output = await cls._bluetoothctl(f"info {address}", timeout=6)
        return bool(re.search(r"(?im)^\s*Paired:\s*yes\s*$", output))

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
    try:
        while line := await asyncio.to_thread(sys.stdin.readline):
            request: dict = {}
            try:
                request = json.loads(line)
                ident, command = request["id"], request["cmd"]
                if command == "connect":
                    result = {"address": await helper.connect(str(request.get("address") or ""))}
                elif command == "scan":
                    result = {"devices": await helper.scan()}
                elif command == "paired":
                    result = {"devices": await helper.paired()}
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
                emit({"id": request.get("id"), "ok": False, "error": str(exc)})
    finally:
        # A normal stdin close (for example when the host is replaced) should
        # release the GATT connection and owner lock before this process exits.
        await helper.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
