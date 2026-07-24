"""Shared fakes for tests (no BLE required)."""

from __future__ import annotations


class FakeTransport:
    """In-memory Transport: records writes, lets tests inject notifications."""

    def __init__(self) -> None:
        self.connected = False
        self.address: str | None = "AA:BB:CC:DD:EE:FF"
        self.writes: dict[str, list[bytes]] = {
            "STATUS": [],
            "SESSIONS": [],
            "TOOLS": [],
            "VOICE": [],
        }
        self._handler = None

    async def connect(self) -> None:
        self.connected = True

    async def disconnect(self) -> None:
        self.connected = False

    def is_connected(self) -> bool:
        return self.connected

    async def write_status(self, payload: bytes) -> None:
        self.writes["STATUS"].append(payload)

    async def write_sessions(self, payload: bytes) -> None:
        self.writes["SESSIONS"].append(payload)

    async def write_tools(self, payload: bytes) -> None:
        self.writes["TOOLS"].append(payload)

    async def write_voice(self, payload: bytes) -> None:
        self.writes["VOICE"].append(payload)

    def set_notify_handler(self, handler) -> None:
        self._handler = handler

    # -- test helpers ---------------------------------------------------------

    def notify(self, name: str, data: bytes) -> None:
        """Simulate a device notification (INPUT/COMMAND JSON or AUDIO binary)."""
        assert self._handler is not None
        self._handler(name, data)

    def last(self, char: str) -> bytes | None:
        return self.writes[char][-1] if self.writes[char] else None
