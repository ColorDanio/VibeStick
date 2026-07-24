#!/usr/bin/env python3
"""VibeStick adapter: Kimi Code CLI hook script.

Kimi Code fires hook events with a JSON payload on stdin
(https://www.kimi.com/code/docs/en/kimi-code-cli/customization/hooks.html).
This script maps them onto VibeStick session state files under
~/.vibestick/sessions/ so the daemon can show this session live.

Register in ~/.kimi-code/config.toml (one [[hooks]] block per event):

    [[hooks]]
    event = "SessionStart"
    command = "python3 /path/to/host/adapters/kimi_hook.py"

    [[hooks]]
    event = "UserPromptSubmit"
    command = "python3 /path/to/host/adapters/kimi_hook.py"

    [[hooks]]
    event = "PreToolUse"
    command = "python3 /path/to/host/adapters/kimi_hook.py"

    [[hooks]]
    event = "Stop"
    command = "python3 /path/to/host/adapters/kimi_hook.py"

    [[hooks]]
    event = "SessionEnd"
    command = "python3 /path/to/host/adapters/kimi_hook.py"

State mapping:
    SessionStart / UserPromptSubmit / PreToolUse -> running
    Stop (turn finished, waiting for the user)    -> waiting
    Interrupt                                     -> waiting
    SessionEnd                                    -> state file removed

Records carry delivery fields so the daemon can reach this CLI:
`pid` (the CLI process, walking past sh/bash wrappers), `tty` (its
controlling pts from /proc/<pid>/stat), and `tmux` when $TMUX_PANE is
set (preferred). UserPromptSubmit also stores the prompt in `last`.
Every hook firing is appended to ~/.vibestick/hook-log.jsonl (last 50).
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from pathlib import Path

SESSIONS_DIR = Path.home() / ".vibestick" / "sessions"
HOOK_LOG = Path.home() / ".vibestick" / "hook-log.jsonl"
HOOK_LOG_MAX = 50
LAST_MAX_CHARS = 60
_SHELLS = ("sh", "bash", "dash", "zsh", "ksh")
PTS_MAJOR = 136  # /dev/pts/* device major on Linux

STATE_BY_EVENT = {
    "SessionStart": "running",
    "UserPromptSubmit": "running",
    "PreToolUse": "running",
    "Stop": "waiting",
    "Interrupt": "waiting",
}

# Payload keys that may carry the user's prompt text (hook docs are
# loose here — take the first that yields a string).
_PROMPT_KEYS = ("prompt", "user_prompt", "userPrompt", "text", "content", "message")


def cli_pid() -> int:
    """The CLI process pid: our parent, past any shell wrappers."""
    pid = os.getppid()
    for _ in range(4):
        try:
            comm = Path(f"/proc/{pid}/comm").read_text().strip()
        except OSError:
            break
        if os.path.basename(comm) not in _SHELLS:
            return pid
        try:
            # /proc/<pid>/stat field 4 = ppid (comm may contain spaces/parens)
            raw = Path(f"/proc/{pid}/stat").read_text()
            pid = int(raw[raw.rindex(")") + 2 :].split()[1])
        except (OSError, ValueError, IndexError):
            break
    return pid


def tty_for_pid(pid: int) -> str:
    """Controlling terminal of pid as /dev/pts/N ("" when none)."""
    try:
        raw = Path(f"/proc/{pid}/stat").read_text()
        tty_nr = int(raw[raw.rindex(")") + 2 :].split()[4])  # field 7 = tty_nr
    except (OSError, ValueError, IndexError):
        return ""
    if tty_nr == 0 or os.major(tty_nr) != PTS_MAJOR:
        return ""
    return f"/dev/pts/{os.minor(tty_nr)}"


def prompt_text(payload: dict) -> str:
    for key in _PROMPT_KEYS:
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return " ".join(value.split())[:LAST_MAX_CHARS]
    return ""


def log_event(event: str, session_id: str, result: str) -> None:
    """Append one line to the hook event log (ring of last 50)."""
    try:
        HOOK_LOG.parent.mkdir(parents=True, exist_ok=True)
        lines = []
        if HOOK_LOG.exists():
            lines = HOOK_LOG.read_text(encoding="utf-8").splitlines()[-(HOOK_LOG_MAX - 1):]
        lines.append(json.dumps({
            "ts": int(time.time()), "event": event,
            "session_id": session_id, "result": result,
        }, ensure_ascii=False))
        HOOK_LOG.write_text("\n".join(lines) + "\n", encoding="utf-8")
    except OSError:
        pass  # observability must never break the hook


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        return  # fail-open: never disturb the CLI

    event = str(payload.get("hook_event_name", ""))
    session_id = str(payload.get("session_id", "")) or "unknown"
    cwd = str(payload.get("cwd", ""))

    state_file = SESSIONS_DIR / f"{session_id}.json"

    if event == "SessionEnd":
        try:
            state_file.unlink()
            log_event(event, session_id, "removed")
        except FileNotFoundError:
            log_event(event, session_id, "removed (absent)")
        return

    state = STATE_BY_EVENT.get(event)
    if state is None:
        return

    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)

    # preserve an existing `last` message across heartbeats
    last = ""
    try:
        last = str(json.loads(state_file.read_text()).get("last", ""))
    except (FileNotFoundError, json.JSONDecodeError, ValueError):
        pass
    if event == "UserPromptSubmit":
        last = prompt_text(payload) or last

    record = {
        "tool": "kimi-cli",
        "model": "",
        "session": os.path.basename(cwd) or session_id,
        "state": state,
        "ctx_pct": -1,
        "cost_usd": -1,
        "last": last,
        "updated": int(time.time()),
        # The state file exists exactly between SessionStart and SessionEnd,
        # so its sessions are foreground-live (v2.1 `fg`).
        "fg": True,
    }
    pane = os.environ.get("TMUX_PANE")
    if pane:
        record["tmux"] = pane

    # zellij session (tmux still wins at resolve time when both exist).
    if os.environ.get("ZELLIJ"):
        zellij_session = os.environ.get("ZELLIJ_SESSION_NAME") or ""
        if zellij_session:
            record["zellij"] = zellij_session
        zellij_pane = os.environ.get("ZELLIJ_PANE_ID")  # 0.44+; may be absent
        if zellij_pane:
            record["zellij_pane"] = zellij_pane

    # Delivery fallback for non-tmux terminals: pid + controlling pts.
    pid = cli_pid()
    if pid:
        record["pid"] = pid
        tty = tty_for_pid(pid)
        if tty:
            record["tty"] = tty

    fd, tmp = tempfile.mkstemp(dir=SESSIONS_DIR, suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(record, f)
    os.replace(tmp, state_file)
    log_event(event, session_id, f"{state} written")


if __name__ == "__main__":
    main()
