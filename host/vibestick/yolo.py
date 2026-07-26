"""Focused-window text and key injection used only by YOLO mode."""
from __future__ import annotations

import asyncio
import logging
import shutil

log = logging.getLogger(__name__)

# Linux input-event codes.  Ctrl+V is the standard paste shortcut for text
# editors and browsers.  (Ctrl+Shift+V is terminal-specific and was not
# accepted by the user's notepad.)
_PASTE = ("29:1", "47:1", "47:0", "29:0")
_CLIPBOARD_READY_DELAY_SEC = 0.02
_PASTE_DELIVERY_GRACE_SEC = 0.08
_CLIPBOARD_READY_ATTEMPTS = 12


class FocusedInput:
    """Put a transcript into whichever application has keyboard focus.

    ``ydotool type`` is a key-map operation, not Unicode text insertion.  It
    is consequently unreliable for Chinese under Wayland.  When the standard
    Wayland clipboard tool is present, copy UTF-8 text then paste it with the
    synthetic keyboard.  ``wtype`` is preferred when available; ydotool's
    direct type command remains the ASCII-only fallback.
    """

    def __init__(self) -> None:
        self.wtype = shutil.which("wtype")
        self.ydotool = shutil.which("ydotool")
        self.clipboard = shutil.which("wl-copy")
        self.clipboard_reader = shutil.which("wl-paste")
        self._clipboard_owner: asyncio.subprocess.Process | None = None
        # Keep this public attribute for callers that only need a capability
        # summary and for compatibility with the earlier implementation.
        self.bin = self.wtype or self.ydotool

    @property
    def available(self) -> bool:
        return self.bin is not None

    async def _run(self, argv: list[str]) -> bool:
        try:
            p = await asyncio.create_subprocess_exec(
                *argv, stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
            _out, err = await p.communicate()
            if p.returncode == 0:
                return True
            log.warning("YOLO input command failed (%s): %s", argv[0],
                        err.decode(errors="replace").strip()[:200])
        except OSError as exc:
            log.warning("YOLO input command could not start (%s): %s", argv[0], exc)
        return False

    async def _stop_clipboard_owner(self) -> None:
        owner = self._clipboard_owner
        self._clipboard_owner = None
        if owner is None or owner.returncode is not None:
            return
        try:
            owner.terminate()
            await owner.wait()
        except OSError:
            pass

    async def _clipboard_matches(self, text: str) -> bool:
        """Read back the selection before injecting Ctrl+V.

        This turns Wayland clipboard ownership into an acknowledged handoff:
        a fresh transcript can never race a stale selection from the previous
        YOLO turn.
        """
        if not self.clipboard_reader:
            await asyncio.sleep(_CLIPBOARD_READY_DELAY_SEC * 2)
            return True
        expected = text.encode("utf-8")
        for _ in range(_CLIPBOARD_READY_ATTEMPTS):
            try:
                p = await asyncio.create_subprocess_exec(
                    self.clipboard_reader, "--no-newline",
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.DEVNULL,
                )
                out, _err = await p.communicate()
                if p.returncode == 0 and out == expected:
                    return True
            except OSError as exc:
                log.warning("YOLO clipboard readback could not start: %s", exc)
                return False
            await asyncio.sleep(_CLIPBOARD_READY_DELAY_SEC)
        log.warning("YOLO clipboard did not become current text before paste")
        return False

    async def _copy(self, text: str) -> bool:
        if not self.clipboard:
            return False
        try:
            await self._stop_clipboard_owner()
            p = await asyncio.create_subprocess_exec(
                # Keep the owner in the foreground while the target requests
                # the bytes.  ``--paste-once`` made a delayed first Ctrl+V
                # consume the prior owner, shifting every transcript by one.
                self.clipboard, "--foreground",
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.PIPE,
            )
            if p.stdin is None:
                log.warning("YOLO clipboard copy has no stdin")
                return False
            p.stdin.write(text.encode("utf-8"))
            await p.stdin.drain()
            p.stdin.close()
            await p.stdin.wait_closed()
            self._clipboard_owner = p
            return await self._clipboard_matches(text)
        except OSError as exc:
            log.warning("YOLO clipboard command could not start: %s", exc)
        return False

    async def text(self, text: str) -> bool:
        if not text:
            return False
        if self.wtype:
            return await self._run([self.wtype, text])
        # Clipboard paste carries Unicode faithfully.  This is the normal
        # Linux/Wayland path on the current host, where wtype is not installed.
        if self.ydotool and self.clipboard:
            copied = await self._copy(text)
            if copied:
                pasted = await self._run([self.ydotool, "key", *_PASTE])
                # Keep the selection alive long enough for the focused client
                # to fetch it, then remove it so it cannot bleed into a later
                # turn.
                await asyncio.sleep(_PASTE_DELIVERY_GRACE_SEC)
                await self._stop_clipboard_owner()
                return pasted
            await self._stop_clipboard_owner()
        if self.ydotool:
            # ydotool accepts the text directly; "--" was previously passed
            # here and became a literal/unsupported argument on this version.
            return await self._run([self.ydotool, "type", text])
        return False

    async def enter(self) -> bool:
        if self.ydotool:
            return await self._run([self.ydotool, "key", "28:1", "28:0"])
        return await self._run([self.wtype, "-k", "Return"]) if self.wtype else False

    async def escape_twice(self) -> bool:
        if self.ydotool:
            one = [self.ydotool, "key", "1:1", "1:0"]
        elif self.wtype:
            one = [self.wtype, "-k", "Escape"]
        else:
            return False
        return await self._run(one) and await self._run(one)
