"""Application-visible keyboard fallback for a broken BlueZ HoG/UHID path."""

from __future__ import annotations

import fcntl
import logging
import os
import struct

log = logging.getLogger(__name__)

EV_SYN = 0x00
EV_KEY = 0x01
SYN_REPORT = 0
BUS_BLUETOOTH = 0x05
KEY_F14 = 184
KEY_F15 = 185
HID_USAGE_F14 = 0x69
HID_USAGE_F15 = 0x6A
USAGE_TO_KEYCODE = {HID_USAGE_F15: KEY_F15, HID_USAGE_F14: KEY_F14}


def _ioc(direction: int, kind: int, number: int, size: int) -> int:
    return (direction << 30) | (size << 16) | (kind << 8) | number


def _iow(kind: int, number: int, size: int = 4) -> int:
    return _ioc(1, kind, number, size)


UI_DEV_CREATE = _ioc(0, ord("U"), 1, 0)
UI_SET_EVBIT = _iow(ord("U"), 100)
UI_SET_KEYBIT = _iow(ord("U"), 101)


class VirtualKeyboard:
    """Minimal uinput keyboard, deliberately dependency-free.

    Native BLE HID remains advertised and connected.  This only fills the
    BlueZ 5.85 bug where its HoG profile consumes valid reports without
    generating Linux input events.
    """

    def __init__(self, path: str = "/dev/uinput") -> None:
        self._fd: int | None = None
        self._path = path
        self._pressed: set[int] = set()

    def _open(self) -> bool:
        if self._fd is not None:
            return True
        try:
            fd = os.open(self._path, os.O_WRONLY | os.O_NONBLOCK)
            fcntl.ioctl(fd, UI_SET_EVBIT, EV_KEY)
            for key in (KEY_F14, KEY_F15):
                fcntl.ioctl(fd, UI_SET_KEYBIT, key)
            # struct uinput_user_dev: name, input_id, ff_effects_max, absinfo
            setup = struct.pack("80sHHHHI" + "i" * 256,
                                b"VibeStick Virtual Keyboard", BUS_BLUETOOTH,
                                0x02AC, 0x0001, 1, 0, *([0] * 256))
            os.write(fd, setup)
            fcntl.ioctl(fd, UI_DEV_CREATE)
            self._fd = fd
            log.info("VibeStick virtual keyboard created")
            return True
        except OSError as exc:
            log.warning("VibeStick HID fallback unavailable (%s): %s", self._path, exc)
            return False

    def start(self) -> bool:
        """Register before the first physical press so it cannot be lost."""
        return self._open()

    def report(self, data: bytes) -> None:
        """Translate a standard keyboard report (with or without ID 1)."""
        if len(data) == 9 and data[0] == 1:
            data = data[1:]
        if len(data) != 8:
            log.debug("ignored malformed HID report: %s", data.hex())
            return
        # Keyboard reports carry USB HID usages (F14=0x69, F15=0x6A), while
        # uinput expects Linux input-event keycodes (184/185).
        keys = {USAGE_TO_KEYCODE[usage] for usage in data[2:] if usage in USAGE_TO_KEYCODE}
        if keys == self._pressed:
            return
        if not self._open():
            return
        for code in self._pressed - keys:
            self._emit(code, 0)
        for code in keys - self._pressed:
            self._emit(code, 1)
        self._sync()
        self._pressed = keys

    def _emit(self, code: int, value: int) -> None:
        assert self._fd is not None
        os.write(self._fd, struct.pack("llHHi", 0, 0, EV_KEY, code, value))

    def _sync(self) -> None:
        assert self._fd is not None
        os.write(self._fd, struct.pack("llHHi", 0, 0, EV_SYN, SYN_REPORT, 0))
