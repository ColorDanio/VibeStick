"""Focused-window keyboard injection used only by YOLO mode."""
from __future__ import annotations
import asyncio
import shutil

class FocusedInput:
    def __init__(self) -> None:
        self.bin = shutil.which("ydotool") or shutil.which("wtype")
    @property
    def available(self) -> bool: return self.bin is not None
    async def _run(self, argv: list[str]) -> bool:
        if not self.bin: return False
        try:
            p = await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
            return await p.wait() == 0
        except OSError: return False
    async def text(self, text: str) -> bool:
        return await self._run([self.bin, "type", "--", text] if self.bin and self.bin.endswith("ydotool") else [self.bin or "", text])
    async def enter(self) -> bool:
        return await self._run([self.bin, "key", "28:1"] if self.bin and self.bin.endswith("ydotool") else [self.bin or "", "-k", "Return"])
    async def escape_twice(self) -> bool:
        one = [self.bin, "key", "1:1"] if self.bin and self.bin.endswith("ydotool") else [self.bin or "", "-k", "Escape"]
        return await self._run(one) and await self._run(one)
