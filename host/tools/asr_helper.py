#!/usr/bin/env python3
"""One-shot local ASR adapter for the TypeScript VibeConn 2.0 runtime.

The TypeScript runtime owns recording state, routing, BLE and delivery.  This
small process boundary only exposes the already-installed local model runtime
that VibeConn 1.x uses, so 2.0 can preserve the user's model/device/language
configuration without shipping a second Whisper implementation.
"""
from __future__ import annotations

import base64
import json
import sys

from vibestick.config import ASRConfig
from vibestick.voice import VoicePipeline


def main() -> None:
    try:
        request = json.loads(sys.stdin.readline())
        if not isinstance(request, dict):
            raise ValueError("request must be an object")
        asr = ASRConfig.from_dict(request.get("asr"))
        if asr.engine not in ("faster-whisper", "command"):
            raise ValueError("local helper supports faster-whisper or command ASR")
        pcm = base64.b64decode(str(request.get("pcm") or ""), validate=True)
        text, meta = VoicePipeline(asr, lambda _payload: None)._transcribe(pcm)
        print(json.dumps({"ok": True, "text": text, "meta": meta}, ensure_ascii=False), flush=True)
    except Exception as exc:  # structured error; the TypeScript pipeline owns UI state
        print(json.dumps({"ok": False, "error": str(exc)[:300]}), flush=True)


if __name__ == "__main__":
    main()
