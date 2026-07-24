#!/usr/bin/env python3
"""ASR diagnostic: transcribe a WAV with each whisper model and compare.

Usage:
    python host/tools/asr_debug.py ~/.vibestick/clips/clip-1.wav [model ...]

Prints audio statistics (duration, peak, RMS, clipping ratio) and the
transcription from each requested model (default: tiny base small) with
its detected language and wall time. Real models are downloaded on first
use — this script is for manual debugging, not for tests.
"""

from __future__ import annotations

import sys
import time
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from vibestick import voice  # noqa: E402
from vibestick.config import ASRConfig  # noqa: E402


def read_wav(path: Path) -> tuple[bytes, int]:
    with wave.open(str(path), "rb") as w:
        if w.getsampwidth() != 1 or w.getnchannels() != 1:
            print(f"warning: {path.name} is {w.getnchannels()}ch/{w.getsampwidth() * 8}-bit; "
                  "expected mono 8-bit — stats may be off")
        return w.readframes(w.getnframes()), w.getframerate()


def audio_stats(pcm: bytes, rate: int) -> str:
    import numpy as np

    a = (np.frombuffer(pcm, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    peak = float(np.max(np.abs(a))) if len(a) else 0.0
    rms = float(np.sqrt(np.mean(a**2))) if len(a) else 0.0
    clipped = float(np.mean(np.abs(a) > 0.98)) if len(a) else 0.0
    return (f"duration={len(a) / rate:.2f}s peak={peak:.3f} rms={rms:.4f} "
            f"clipped={clipped:.2%}")


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    wav_path = Path(sys.argv[1])
    models = sys.argv[2:] or ["tiny", "base", "small"]
    pcm, rate = read_wav(wav_path)
    print(f"file: {wav_path}  rate={rate}")
    print(f"stats: {audio_stats(pcm, rate)}")
    print(f"initial_prompt: {voice.INITIAL_PROMPT!r}")
    print()
    for model_name in models:
        asr = ASRConfig(engine="faster-whisper", model=model_name, device="cpu")
        start = time.time()
        try:
            text, meta = voice._transcribe_faster_whisper(asr, pcm)
            elapsed = time.time() - start
            print(f"[{model_name}] ({elapsed:.1f}s, lang={meta.get('language')})")
            print(f"  {text!r}")
        except Exception as exc:  # noqa: BLE001
            print(f"[{model_name}] FAILED: {exc}")
        print()


if __name__ == "__main__":
    main()
