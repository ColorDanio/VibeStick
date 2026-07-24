"""Deliver INPUT messages from the device to the active CLI session.

The delivery method is recorded by the adapter in the session's state
file: a `tmux` pane id (preferred) or a `tty` device path. tty delivery
injects bytes into the terminal's input queue via the TIOCSTI ioctl —
plain os.write() on a pts slave only *displays* text, it never reaches
the CLI's stdin. Everything here is defensive: timeouts, non-blocking
writes, and no exceptions escaping to the caller.
"""

from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path

log = logging.getLogger(__name__)

TMUX_TIMEOUT_SEC = 5.0

DELIVERY_MODES = ("auto", "tmux", "tty")

# Overridable for tests (fake /proc and pts trees).
_PROC_ROOT = "/proc"
_DEVPTS = "/dev/pts"


def _legacy_tiocsti() -> str:
    """Kernel TIOCSTI toggle, for diagnostics ('0' = injection blocked)."""
    try:
        return Path("/proc/sys/dev/tty/legacy_tiocsti").read_text().strip()
    except OSError:
        return "unknown"


def _inject_tty(fd: int, data: bytes) -> None:
    """Push bytes into the tty input queue, one TIOCSTI per byte."""
    import fcntl
    import termios

    for i in range(len(data)):
        fcntl.ioctl(fd, termios.TIOCSTI, data[i : i + 1])


def _write_tty_input(tty: str, data: bytes) -> None:
    fd = os.open(tty, os.O_WRONLY | os.O_NONBLOCK)
    try:
        _inject_tty(fd, data)
    finally:
        os.close(fd)


def resolve_target(record: dict | None, mode: str = "auto") -> tuple[str, str] | None:
    """Pick a delivery target ("tmux"|"tty", value) per the tool's mode.

    auto: tmux pane preferred, tty fallback; tmux/tty: restrict.
    Records that carry a pid but no tty get one resolved from
    /proc/<pid>/stat (controlling terminal) — e.g. discovered sessions
    whose presence scan ran before the terminal existed.
    """
    record = record or {}
    tmux_pane = str(record.get("tmux") or "")
    tty = str(record.get("tty") or "")
    if not tty and record.get("pid"):
        tty = _tty_for_pid(int(record["pid"])) or ""
    if mode == "tmux":
        return ("tmux", tmux_pane) if tmux_pane else None
    if mode == "tty":
        return ("tty", tty) if tty else None
    if tmux_pane:
        return ("tmux", tmux_pane)
    if tty:
        return ("tty", tty)
    return None


def _tty_for_pid(pid: int) -> str | None:
    """Controlling-terminal pts of a live process, or None."""
    from . import procwatch

    stat = procwatch.read_proc_stat(pid, _PROC_ROOT)
    if stat is None or not stat.tty_nr:
        return None
    return procwatch.tty_path_for(stat.tty_nr, _DEVPTS)


def tty_gate_ok(pid: int, tty_path: str, proc_root: str | None = None,
                devpts: str | None = None) -> bool:
    """Safety gate before writing to a pts.

    Passes only when the process is alive, its controlling terminal is
    still `tty_path`, the process (or an ancestor) is in that terminal's
    foreground process group, and the pts is writable. Records without a
    pid (e.g. adapter-reported tty) fall back to the writability check.
    """
    from . import procwatch

    if not tty_path:
        return False
    if pid:
        proc_root = proc_root or _PROC_ROOT
        devpts = devpts or _DEVPTS
        stat = procwatch.read_proc_stat(pid, proc_root)
        if stat is None:
            log.info("tty gate: pid %s gone", pid)
            return False
        actual = procwatch.tty_path_for(stat.tty_nr, devpts)
        if actual != tty_path:
            log.info("tty gate: pid %s terminal moved (%r != %r)", pid, actual, tty_path)
            return False
        if not procwatch.is_foreground(stat, proc_root):
            log.info("tty gate: pid %s not in foreground pgroup of %s", pid, tty_path)
            return False
    return os.access(tty_path, os.W_OK)

# Key names accepted by tmux send-keys, keyed by lowercase binding name.
_KEY_NAMES = {
    "enter": "Enter",
    "escape": "Escape",
    "esc": "Escape",
    "tab": "Tab",
    "space": "Space",
    "backspace": "BSpace",
    "delete": "DC",
    "up": "Up",
    "down": "Down",
    "left": "Left",
    "right": "Right",
    "home": "Home",
    "end": "End",
    "pageup": "PageUp",
    "pagedown": "PageDown",
    **{f"f{i}": f"F{i}" for i in range(1, 13)},
}
_MODIFIERS = {"ctrl": "C", "control": "C", "c": "C", "alt": "M", "meta": "M", "m": "M", "shift": "S", "s": "S"}


def map_binding(binding: str) -> tuple[list[str], bool]:
    """Map a binding string to tmux send-keys arguments.

    Returns (args, literal): literal bindings (arbitrary text) are sent
    with `-l`; key bindings (e.g. "ctrl-c", "C-c", "escape", "Enter")
    become tmux key names like "C-c"/"Escape".
    """
    binding = binding.strip()
    parts = binding.split("-")
    mods: list[str] = []
    while len(parts) > 1 and parts[0].lower() in _MODIFIERS:
        mods.append(_MODIFIERS[parts.pop(0).lower()])
    key = "-".join(parts)
    mapped = _KEY_NAMES.get(key.lower())
    if mods:
        key_name = mapped or (key if len(key) == 1 else key)
        if mapped is None and len(key) != 1:
            # e.g. "ctrl-pageup" -> "C-PageUp"; unknown long names pass through
            key_name = key[:1].upper() + key[1:]
        return (["-".join(dict.fromkeys(mods)) + "-" + key_name], False)
    if mapped is not None:
        return ([mapped], False)
    if len(binding) == 1:
        return ([binding], False)
    return ([binding], True)


async def send_binding(record: dict | None, binding: str, mode: str = "auto") -> bool:
    """Send a key binding to the session described by a raw state file.

    tmux: `send-keys` with mapped key names or `-l` for literal strings.
    tty: best-effort write of common control bytes / literal text
    (gated by tty_gate_ok). Returns True on handoff to some transport.
    """
    if not binding or not binding.strip():
        return False
    record = record or {}
    target = resolve_target(record, mode)
    if target is None:
        log.info("no delivery method for session; binding dropped: %r", binding)
        return False
    kind, value = target
    if kind == "tmux":
        return await _send_binding_tmux(value, binding)
    return await _send_binding_tty(value, binding, pid=int(record.get("pid") or 0))


async def _send_binding_tmux(pane: str, binding: str) -> bool:
    args, literal = map_binding(binding)
    argv = ["tmux", "send-keys", "-t", pane]
    if literal:
        argv += ["-l", "--", args[0]]
    else:
        argv += ["--", *args]
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await asyncio.wait_for(proc.communicate(), timeout=TMUX_TIMEOUT_SEC)
        if proc.returncode != 0:
            log.warning("tmux send-keys to %s failed: %s", pane, stderr.decode(errors="replace").strip())
            return False
        return True
    except (OSError, asyncio.TimeoutError) as exc:
        log.warning("tmux binding delivery to %s failed: %s", pane, exc)
        return False


_TTY_KEYS = {"enter": "\r", "escape": "\x1b", "tab": "\t", "backspace": "\x7f"}


async def _send_binding_tty(tty: str, binding: str, pid: int = 0) -> bool:
    args, literal = map_binding(binding)
    if literal:
        data = args[0]
    else:
        key = args[0]
        if key.startswith("C-") and len(key) == 3:
            data = chr(ord(key[2].lower()) & 0x1F)  # ctrl byte, e.g. C-c -> \x03
        else:
            data = _TTY_KEYS.get(key.lower())
            if data is None:
                log.info("binding %r not representable on tty; dropped", binding)
                return False
    if not tty_gate_ok(pid, tty):
        log.info("tty gate rejected binding delivery to %s", tty)
        return False

    try:
        await asyncio.wait_for(
            asyncio.to_thread(_write_tty_input, tty, data.encode("utf-8")),
            timeout=TMUX_TIMEOUT_SEC,
        )
        return True
    except (OSError, asyncio.TimeoutError) as exc:
        log.warning(
            "tty binding delivery to %s failed: %s (dev.tty.legacy_tiocsti=%s; "
            "TIOCSTI injection requires it to be 1)",
            tty, exc, _legacy_tiocsti(),
        )
        return False


async def deliver_text(record: dict | None, text: str, mode: str = "auto") -> bool:
    """Deliver `text` + Enter to the session described by a raw state file.

    Returns True if the message was handed off to some transport.
    """
    if not text:
        return False
    record = record or {}
    target = resolve_target(record, mode)
    if target is None:
        log.info("no delivery method for session; message dropped: %r", text)
        return False
    kind, value = target
    if kind == "tmux":
        return await _deliver_tmux(value, text)
    return await _deliver_tty(value, text, pid=int(record.get("pid") or 0))


async def _deliver_tmux(pane: str, text: str) -> bool:
    try:
        proc = await asyncio.create_subprocess_exec(
            "tmux", "send-keys", "-t", pane, "--", text, "Enter",
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await asyncio.wait_for(proc.communicate(), timeout=TMUX_TIMEOUT_SEC)
        if proc.returncode != 0:
            log.warning("tmux send-keys to %s failed: %s", pane, stderr.decode(errors="replace").strip())
            return False
        return True
    except (OSError, asyncio.TimeoutError) as exc:
        log.warning("tmux delivery to %s failed: %s", pane, exc)
        return False


async def _deliver_tty(tty: str, text: str, pid: int = 0) -> bool:
    if not tty_gate_ok(pid, tty):
        log.info("tty gate rejected delivery to %s", tty)
        return False

    try:
        await asyncio.wait_for(
            asyncio.to_thread(_write_tty_input, tty, (text + "\r").encode("utf-8")),
            timeout=TMUX_TIMEOUT_SEC,
        )
        return True
    except (OSError, asyncio.TimeoutError) as exc:
        log.warning(
            "tty delivery to %s failed: %s (dev.tty.legacy_tiocsti=%s; "
            "TIOCSTI injection requires it to be 1)",
            tty, exc, _legacy_tiocsti(),
        )
        return False


async def launch_tmux_window(target_pane: str, name: str, command: str) -> bool:
    """Open a new tmux window running `command` (session.new).

    `target_pane` anchors the tmux session (an existing session's pane).
    Everything best-effort: failures are logged, never raised.
    """
    if not target_pane or not command:
        return False
    argv = ["tmux", "new-window", "-t", target_pane, "-n", name, "--", command]
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await asyncio.wait_for(proc.communicate(), timeout=TMUX_TIMEOUT_SEC)
        if proc.returncode != 0:
            log.warning("tmux new-window failed: %s", stderr.decode(errors="replace").strip())
            return False
        log.info("launched new tmux window %r running %r", name, command)
        return True
    except (OSError, asyncio.TimeoutError) as exc:
        log.warning("tmux new-window failed: %s", exc)
        return False
