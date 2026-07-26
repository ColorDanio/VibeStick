#!/usr/bin/env python3
"""Read-only 1.x session discovery adapter for VibeConn 2.0 on Linux.

The TypeScript HostCore remains the source of selection, BLE payload and
delivery policy.  This one-shot helper only reuses the mature local readers
for Claude, Codex, OpenCode and Kimi session stores, plus the Linux process
metadata that identifies a safe terminal target.  It never connects BLE,
writes a session store, or launches a command.
"""
from __future__ import annotations

import json
import sys

from vibestick.config import Config
from vibestick.discover import SessionDiscovery
from vibestick.procwatch import ProcessWatcher
from vibestick.store import SessionStore


def main() -> None:
    try:
        request = json.loads(sys.stdin.readline())
        if not isinstance(request, dict):
            raise ValueError("request must be an object")
        config = Config.from_dict(request.get("config") or {})
        # No adapter-directory refresh: HostCore reads that portable source
        # itself.  This keeps the Python boundary strictly discovery/presence.
        store = SessionStore(config=config, watcher=ProcessWatcher(), discovery=SessionDiscovery())
        store.refresh_presence()
        store.refresh_discovery()
        records = []
        for tool in store.visible_tools():
            for record in store.sessions_for_tool(tool.id):
                records.append({
                    "id": record.id,
                    "status": record.status.to_dict(),
                    "fg": store.fg_for(record),
                    "raw": record.raw,
                })
        print(json.dumps({"ok": True, "records": records}, ensure_ascii=False), flush=True)
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)[:300]}), flush=True)


if __name__ == "__main__":
    main()
