"""Process presence watcher: finds CLI tools that run without an adapter.

Linux-only, no dependencies: scans /proc/*/cmdline for processes whose
executable name matches a configured per-tool `process` name. The proc
root is injectable so tests can point the watcher at a fixture tree.

Matching rules (kept deliberately strict to avoid false positives):

- The real binary (`/proc/PID/exe` symlink) is checked first: exact
  basename match. Desktop applications installed in a `<name>-desktop`
  directory (electron apps like codex-desktop) are NOT the CLI and are
  excluded.
- Otherwise argv[0] must match exactly (same desktop-dir exclusion).
- argv[1] only counts when argv[0] is a known interpreter
  (python/python3.x/node) — pip console scripts and npm CLIs show up as
  e.g. "python3 /usr/local/bin/kimi ...".
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)

DEFAULT_PROC_ROOT = Path("/proc")

_INTERPRETER_NAMES = frozenset({"python", "python2", "python3", "node", "nodejs"})

# cwd basenames that carry no useful session information.
_GENERIC_CWD = frozenset(
    {"bin", "sbin", "app", "apps", "opt", "usr", "lib", "libexec", "home", "root", "desktop"}
)


def _is_interpreter(name: str) -> bool:
    return name in _INTERPRETER_NAMES or name.startswith("python3.")


@dataclass
class ProcStat:
    """Parsed /proc/<pid>/stat fields we care about."""

    pid: int
    ppid: int
    pgrp: int  # process group id
    tty_nr: int  # controlling terminal device number (0 = none)
    tpgid: int  # foreground process group of the controlling terminal


def read_proc_stat(pid: int, proc_root: str | Path = DEFAULT_PROC_ROOT) -> ProcStat | None:
    """Parse /proc/<pid>/stat; None if the process is gone/unreadable."""
    try:
        raw = (Path(proc_root) / str(pid) / "stat").read_text()
    except OSError:
        return None
    # comm (field 2) may contain spaces/parens — split after the last ')'.
    try:
        rest = raw[raw.rindex(")") + 2:].split()
        return ProcStat(
            pid=pid,
            ppid=int(rest[1]),
            pgrp=int(rest[2]),
            tty_nr=int(rest[4]),
            tpgid=int(rest[5]),
        )
    except (ValueError, IndexError):
        return None


def tty_path_for(tty_nr: int, devpts: str = "/dev/pts") -> str | None:
    """Decode a stat tty_nr device number to a pts path (major 136 = pts)."""
    if tty_nr == 0 or os.major(tty_nr) != 136:
        return None
    return f"{devpts}/{os.minor(tty_nr)}"


def is_foreground(stat: ProcStat, proc_root: str | Path = DEFAULT_PROC_ROOT, max_depth: int = 8) -> bool:
    """True if the process (or an ancestor) is in its terminal's foreground
    process group — i.e. the CLI actually owns the pts right now."""
    if stat.tty_nr == 0 or stat.tpgid <= 0:
        return False
    current: ProcStat | None = stat
    for _ in range(max_depth):
        if current is None:
            return False
        if current.pgrp == stat.tpgid:
            return True
        if current.ppid <= 1:
            return False
        current = read_proc_stat(current.ppid, proc_root)
    return False


@dataclass
class ProcInfo:
    """A live process matching a tool's configured process name."""

    pid: int
    name: str  # matched executable basename
    cwd: str  # process working directory, "" if unreadable
    tty: str = ""  # /dev/pts/X of its controlling terminal, "" if none
    zellij: str = ""
    zellij_pane: str = ""

    @property
    def cwd_basename(self) -> str:
        return os.path.basename(self.cwd.rstrip("/")) if self.cwd else ""

    def session_label(self) -> str:
        """Human label for the synthesized session.

        The cwd basename when it is informative; otherwise (cwd missing,
        equals the process name, or a generic/install directory) a
        process-identifying fallback.
        """
        base = self.cwd_basename
        if base and base != self.name and base not in _GENERIC_CWD and not base.endswith("-desktop"):
            return base
        return f"{self.name} (pid {self.pid})"


class ProcessWatcher:
    """Scans a proc filesystem for processes by executable name."""

    def __init__(self, proc_root: str | Path = DEFAULT_PROC_ROOT) -> None:
        self.proc_root = Path(proc_root)

    def scan(self, names: set[str]) -> dict[str, "ProcInfo"]:
        """Return {process_name: ProcInfo} for the first live match per name."""
        found: dict[str, ProcInfo] = {}
        if not names:
            return found
        try:
            entries = os.listdir(self.proc_root)
        except OSError as exc:
            log.warning("cannot list %s: %s", self.proc_root, exc)
            return found
        for entry in entries:
            if not entry.isdigit():
                continue
            try:
                raw = (self.proc_root / entry / "cmdline").read_bytes()
            except OSError:
                continue  # process exited, or not readable
            if not raw:
                continue  # kernel thread
            args = [a.decode("utf-8", errors="replace") for a in raw.split(b"\0") if a]
            try:
                exe = os.readlink(self.proc_root / entry / "exe")
            except OSError:
                exe = ""
            match = self._match(args, exe, names)
            if match is None or match in found:
                continue
            try:
                cwd = os.readlink(self.proc_root / entry / "cwd")
            except OSError:
                cwd = ""
            tty = ""
            stat = read_proc_stat(int(entry), self.proc_root)
            if stat is not None and stat.tty_nr:
                tty = tty_path_for(stat.tty_nr) or ""
            try:
                env = (self.proc_root / entry / "environ").read_bytes().split(b"\0")
                vals = {x.split(b"=", 1)[0]: x.split(b"=", 1)[1].decode(errors="replace")
                        for x in env if b"=" in x}
            except OSError:
                vals = {}
            found[match] = ProcInfo(pid=int(entry), name=match, cwd=cwd, tty=tty,
                                    zellij=vals.get(b"ZELLIJ_SESSION_NAME", ""),
                                    zellij_pane=vals.get(b"ZELLIJ_PANE_ID", ""))
            if len(found) == len(names):
                break
        return found

    @classmethod
    def _match(cls, args: list[str], exe: str, names: set[str]) -> str | None:
        # Ground truth first: the actual binary behind the process.
        if exe:
            base = os.path.basename(exe)
            if base in names:
                if cls._desktop_app_dir(os.path.basename(os.path.dirname(exe))):
                    log.debug("ignoring desktop app at %s", exe)
                    return None
                return base
        if not args:
            return None
        first = os.path.basename(args[0])
        if first in names:
            if cls._desktop_app_dir(cls._dir_basename(args[0], exe)):
                log.debug("ignoring desktop app launched as %r", args[0])
                return None
            return first
        # Interpreter-launched CLI: "python3 /path/to/kimi ..." -> match argv[1].
        if len(args) > 1 and _is_interpreter(first):
            second = os.path.basename(args[1])
            if second in names:
                return second
        return None

    @staticmethod
    def _dir_basename(argv0: str, exe: str) -> str:
        """Directory basename of the executable (exe preferred, argv[0] fallback)."""
        for path in (exe, argv0):
            if "/" in path:
                return os.path.basename(os.path.dirname(path))
        return ""

    @staticmethod
    def _desktop_app_dir(dir_base: str) -> bool:
        """Electron-style desktop apps install as <name>-desktop/<name>."""
        return bool(dir_base) and dir_base.endswith("-desktop")
