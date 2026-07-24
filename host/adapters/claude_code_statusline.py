#!/usr/bin/env python3
"""Claude Code statusLine adapter for VibeStick.

Register in ~/.claude/settings.json:

    {
      "statusLine": {
        "type": "command",
        "command": "python3 /path/to/host/adapters/claude_code_statusline.py"
      }
    }

Claude Code pipes a JSON snapshot of the session on stdin; this script
maps it to the VibeStick STATUS schema and writes
~/.vibestick/sessions/<session_id>.json. It still prints a one-line
status to stdout so the terminal status line keeps working.
"""

import json
import os
import sys
import time

STATE_DIR = os.path.expanduser("~/.vibestick/sessions")


def main() -> None:
    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError:
        data = {}

    session_id = data.get("session_id") or "unknown"
    model = (data.get("model") or {}).get("display_name") or ""
    cwd = (data.get("workspace") or {}).get("current_dir") or ""
    name = os.path.basename(cwd.rstrip("/")) if cwd else session_id

    # Cost / context fields are present on newer Claude Code versions;
    # probe defensively and fall back to the protocol's "unknown" (-1).
    cost = (data.get("cost") or {}).get("total_cost_usd")
    cost_usd = float(cost) if isinstance(cost, (int, float)) else -1
    ctx = (data.get("context") or {}).get("used_percentage")
    ctx_pct = int(ctx) if isinstance(ctx, (int, float)) else -1

    record = {
        "id": session_id,
        "tool": "claude-code",
        "model": model,
        "session": name,
        "state": "running",
        "ctx_pct": ctx_pct,
        "cost_usd": cost_usd,
        "last": "",
        "updated": int(time.time()),
    }
    pane = os.environ.get("TMUX_PANE")
    if pane:
        record["tmux"] = pane

    os.makedirs(STATE_DIR, exist_ok=True)
    path = os.path.join(STATE_DIR, f"{session_id}.json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(record, f)
    os.replace(tmp, path)

    # Keep the terminal status line useful.
    print(f"{model} | {name}")


if __name__ == "__main__":
    main()
