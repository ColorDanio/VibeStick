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


def _download_model(model: str) -> None:
    """Download a model while reporting monotonic progress on stderr."""
    import huggingface_hub
    from faster_whisper import utils
    from tqdm.auto import tqdm

    repo_id = utils._MODELS.get(model)  # faster-whisper's canonical model map
    if repo_id is None:
        raise ValueError(f"unknown faster-whisper model: {model}")

    class Progress(tqdm):
        _reported = 0

        def display(self, msg=None, pos=None) -> None:  # keep stderr machine-readable
            return

        def update(self, n=1):
            changed = super().update(n)
            if self.total:
                percent = min(99, max(self.__class__._reported,
                                      int(self.n * 100 / self.total)))
                if percent > self.__class__._reported:
                    self.__class__._reported = percent
                    print(json.dumps({"event": "progress", "progress": percent}),
                          file=sys.stderr, flush=True)
            return changed

    huggingface_hub.snapshot_download(
        repo_id,
        allow_patterns=["config.json", "preprocessor_config.json", "model.bin",
                        "tokenizer.json", "vocabulary.*"],
        tqdm_class=Progress,
    )


def main() -> None:
    try:
        request = json.loads(sys.stdin.readline())
        if not isinstance(request, dict):
            raise ValueError("request must be an object")
        asr = ASRConfig.from_dict(request.get("asr"))
        if asr.engine not in ("faster-whisper", "command"):
            raise ValueError("local helper supports faster-whisper or command ASR")
        action = request.get("action")
        if action == "download":
            if asr.engine != "faster-whisper":
                raise ValueError("only faster-whisper models can be downloaded")
            _download_model(asr.model)
            print(json.dumps({"event": "progress", "progress": 100}),
                  file=sys.stderr, flush=True)
            print(json.dumps({"ok": True, "model": asr.model}), flush=True)
            return
        if action == "apply":
            if asr.engine != "faster-whisper":
                raise ValueError("only faster-whisper models can be prepared")
            from faster_whisper import WhisperModel

            WhisperModel(asr.model, device=asr.device, local_files_only=True)
            print(json.dumps({"ok": True, "model": asr.model}), flush=True)
            return
        pcm = base64.b64decode(str(request.get("pcm") or ""), validate=True)
        text, meta = VoicePipeline(asr, lambda _payload: None)._transcribe(pcm)
        print(json.dumps({"ok": True, "text": text, "meta": meta}, ensure_ascii=False), flush=True)
    except Exception as exc:  # structured error; the TypeScript pipeline owns UI state
        print(json.dumps({"ok": False, "error": str(exc)[:300]}), flush=True)


if __name__ == "__main__":
    main()
