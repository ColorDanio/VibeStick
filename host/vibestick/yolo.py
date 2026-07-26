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
_CLIPBOARD_READY_DELAY_SEC = 0.04


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

    async def _copy(self, text: str) -> bool:
        if not self.clipboard:
            return False
        try:
            p = await asyncio.create_subprocess_exec(
                # Keep the owner in the foreground and serve exactly the
                # upcoming Ctrl+V.  Waiting for the default wl-copy process
                # races its background owner startup, which is why the first
                # YOLO utterance could be missed while later ones succeeded.
                self.clipboard, "--foreground", "--paste-once",
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
            # wl-copy now owns the selection, but exits only after the paste
            # request.  Do not await it here or the first injection blocks.
            asyncio.create_task(self._reap_clipboard(p))
            await asyncio.sleep(_CLIPBOARD_READY_DELAY_SEC)
            return True
        except OSError as exc:
            log.warning("YOLO clipboard command could not start: %s", exc)
        return False

    async def _reap_clipboard(self, process: asyncio.subprocess.Process) -> None:
        """Collect one-shot wl-copy once ydotool has consumed the selection."""
        try:
            await process.wait()
        except OSError:
            pass

    async def text(self, text: str) -> bool:
        if not text:
            return False
        if self.wtype:
            return await self._run([self.wtype, text])
        # Clipboard paste carries Unicode faithfully.  This is the normal
        # Linux/Wayland path on the current host, where wtype is not installed.
        if self.ydotool and self.clipboard and await self._copy(text):
            return await self._run([self.ydotool, "key", *_PASTE])
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
