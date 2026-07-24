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
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from pathlib import Path

SESSIONS_DIR = Path.home() / ".vibestick" / "sessions"

STATE_BY_EVENT = {
    "SessionStart": "running",
    "UserPromptSubmit": "running",
    "PreToolUse": "running",
    "Stop": "waiting",
    "Interrupt": "waiting",
}


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
        except FileNotFoundError:
            pass
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

    fd, tmp = tempfile.mkstemp(dir=SESSIONS_DIR, suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(record, f)
    os.replace(tmp, state_file)


if __name__ == "__main__":
    main()
