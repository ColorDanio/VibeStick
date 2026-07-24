"""Voice pipeline: records AUDIO frames, transcribes, delivers transcripts.

Flow (docs/protocol.md): voice.start opens the recording buffer; binary
AUDIO frames (8 kHz, 8-bit unsigned PCM, mono) accumulate until
voice.stop; the configured ASR engine transcribes; voice.confirm delivers
the transcript to the selected tool's active session; voice.cancel
discards it. Every state change is pushed as a VOICE payload.
Every transcription attempt is recorded in a TranscriptionLog (ring
buffer + ~/.vibestick/voice-log.jsonl) so failures are visible after
the fact (dashboard Voice & Mic page, /api/status asr.recent).
"""

from __future__ import annotations

import asyncio
import json
import logging
import shlex
import subprocess
import tempfile
import time
import traceback
import wave
from collections import deque
from pathlib import Path
from typing import Callable

from . import protocol
from .config import ASRConfig

log = logging.getLogger(__name__)

MAX_DURATION_SEC = 25  # ~25s of 8 kHz 8-bit mono = 200 KB
COMMAND_TIMEOUT_SEC = 180
WHISPER_SAMPLE_RATE = 16000
LOG_PATH = Path.home() / ".vibestick" / "voice-log.jsonl"
RECENT_TRANSCRIPTIONS = 20

StateCallback = Callable[[str], None]  # receives VOICE payload JSON strings
DeliverCallback = Callable[[str], None]
Transcriber = Callable[[bytes], str]  # pcm bytes -> transcript


class TranscriptionLog:
    """Ring buffer of transcription attempts, mirrored to a JSONL file."""

    def __init__(self, path: Path | str | None = LOG_PATH, maxlen: int = RECENT_TRANSCRIPTIONS) -> None:
        self._entries: deque[dict] = deque(maxlen=maxlen)
        self._path = Path(path) if path else None

    def record(self, entry: dict) -> None:
        """entry: {ts, duration_sec, engine, state, text?, reason?}"""
        entry.setdefault("ts", int(time.time()))
        self._entries.append(entry)
        if self._path is not None:
            try:
                self._path.parent.mkdir(parents=True, exist_ok=True)
                with open(self._path, "a", encoding="utf-8") as f:
                    f.write(json.dumps(entry, ensure_ascii=False) + "\n")
            except OSError as exc:
                log.debug("voice log write failed: %s", exc)

    def recent(self) -> list[dict]:
        """Newest first."""
        return list(reversed(self._entries))


def _summarize_exc(exc: BaseException) -> str:
    """One-line failure reason from an exception (last traceback frame)."""
    summary = traceback.format_exception_only(type(exc), exc)[-1].strip()
    return summary[:200]


class VoicePipeline:
    """Stateful voice pipeline driven by device commands and AUDIO frames."""

    def __init__(
        self,
        asr: ASRConfig,
        push: StateCallback,
        deliver: DeliverCallback | None = None,
        transcriber: Transcriber | None = None,
        max_duration_sec: int = MAX_DURATION_SEC,
        transcription_log: TranscriptionLog | None = None,
    ) -> None:
        self.asr = asr
        self._push = push
        self._deliver = deliver
        self._transcriber = transcriber
        self.max_duration_sec = max_duration_sec
        self._tlog = transcription_log
        self.state = "idle"
        self.transcript = ""
        self._buf = bytearray()

    # -- commands ------------------------------------------------------------

    def start(self) -> None:
        """voice.start: open a fresh recording buffer."""
        self._buf = bytearray()
        self.transcript = ""
        self._set_state("recording")

    def feed(self, data: bytes) -> None:
        """Consume an AUDIO frame; ignored outside a recording window."""
        if self.state != "recording":
            return
        cap = self.max_duration_sec * protocol.AUDIO_SAMPLE_RATE
        room = cap - len(self._buf)
        if room > 0:
            self._buf += data[:room]

    async def stop(self) -> None:
        """voice.stop: transcribe the buffered audio."""
        if self.state != "recording":
            return
        pcm = bytes(self._buf)
        self._buf = bytearray()
        duration = len(pcm) / protocol.AUDIO_SAMPLE_RATE
        self._set_state("transcribing")
        started = time.monotonic()
        meta: dict = {}
        try:
            text, meta = await asyncio.to_thread(self._transcribe, pcm)
        except Exception as exc:  # noqa: BLE001 - any ASR failure -> error state
            reason = _summarize_exc(exc)
            log.warning("transcription failed: %s", exc)
            self._record_attempt(duration, "error", reason=reason,
                                 processing_sec=time.monotonic() - started, meta=meta)
            self._set_state("error", str(exc) or "transcription failed")
            return
        elapsed = time.monotonic() - started
        text = text.strip()
        if not text:
            reason = (
                "too short" if duration < 0.3
                else "no speech detected (VAD filtered everything)"
            )
            self._record_attempt(duration, "no-speech", reason=reason,
                                 processing_sec=elapsed, meta=meta)
            self._set_state("error", "no speech detected")
            return
        self._record_attempt(duration, "ok", text=text,
                             processing_sec=elapsed, meta=meta)
        self.transcript = text
        self._set_state("ready", text)

    def recent_transcriptions(self) -> list[dict]:
        return self._tlog.recent() if self._tlog is not None else []

    def _record_attempt(self, duration: float, state: str,
                        text: str = "", reason: str = "",
                        processing_sec: float = 0.0, meta: dict | None = None) -> None:
        if self._tlog is None:
            return
        meta = meta or {}
        entry: dict = {
            "duration_sec": round(duration, 2),
            "processing_sec": round(processing_sec, 2),
            "engine": self.asr.engine,
            "model": self.asr.model,
            "state": state,
        }
        if meta.get("language"):
            entry["language"] = meta["language"]
        if text:
            entry["text"] = text[:120]
        if reason:
            entry["reason"] = reason
        self._tlog.record(entry)

    def confirm(self) -> None:
        """voice.confirm: deliver the ready transcript, back to idle."""
        if self.state != "ready":
            return
        if self._deliver is not None:
            self._deliver(self.transcript)
        self.transcript = ""
        self._set_state("idle")

    def cancel(self) -> None:
        """voice.cancel: discard recording/transcript, back to idle."""
        self._buf = bytearray()
        self.transcript = ""
        self._set_state("idle")

    # -- internals -------------------------------------------------------------

    def _set_state(self, state: str, text: str = "") -> None:
        self.state = state
        self._push(protocol.VoicePayload(state=state, text=text).to_json())

    def _transcribe(self, pcm: bytes) -> tuple[str, dict]:
        """Returns (text, meta); meta carries e.g. detected language."""
        if self._transcriber is not None:
            return self._transcriber(pcm), {}
        if self.asr.engine == "command":
            return _transcribe_command(self.asr, pcm)
        return _transcribe_faster_whisper(self.asr, pcm)


def pcm_to_wav(pcm: bytes, path: str | Path) -> None:
    """Write 8 kHz 8-bit unsigned mono PCM as a WAV file."""
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(1)  # 8-bit WAV samples are unsigned, matching our PCM
        w.setframerate(protocol.AUDIO_SAMPLE_RATE)
        w.writeframes(pcm)


def _transcribe_command(asr: ASRConfig, pcm: bytes) -> tuple[str, dict]:
    """Run a user command with a temp WAV path; transcript comes from stdout."""
    if not asr.command.strip():
        raise RuntimeError("asr engine 'command' has no command configured")
    fd, wav_path = tempfile.mkstemp(prefix="vibestick-", suffix=".wav")
    try:
        import os

        os.close(fd)
        pcm_to_wav(pcm, wav_path)
        argv = shlex.split(asr.command) + [wav_path]
        log.info("running asr command: %s", " ".join(argv))
        proc = subprocess.run(
            argv, capture_output=True, timeout=COMMAND_TIMEOUT_SEC, check=False
        )
        if proc.returncode != 0:
            stderr = proc.stderr.decode("utf-8", errors="replace").strip()
            raise RuntimeError(f"asr command exited {proc.returncode}: {stderr[:200]}")
        return proc.stdout.decode("utf-8", errors="replace").strip(), {}
    finally:
        try:
            Path(wav_path).unlink()
        except OSError:
            pass


# Bilingual bias for the auto-detect path: keeps Mandarin output in
# simplified Chinese and prevents traditional-character gibberish.
INITIAL_PROMPT = "Hello. 你好。以下是简体中文和英文混合的语音转写。"


def _transcribe_faster_whisper(asr: ASRConfig, pcm: bytes) -> tuple[str, dict]:
    """Transcribe with faster-whisper (optional dependency, imported lazily).

    Returns (text, meta) with meta["language"] = detected language code.
    """
    try:
        import numpy as np
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise RuntimeError(
            "faster-whisper/numpy not installed; run: pip install 'vibestick[asr]'"
        ) from exc
    # 8-bit unsigned PCM -> float32 in [-1, 1]
    audio = (np.frombuffer(pcm, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    if len(audio) == 0:
        return "", {}
    # The stick's PDM mic is quiet; peak-normalize so whisper's VAD can
    # detect normal speech. 99th percentile keeps single clicks from
    # suppressing the gain; the cap avoids boosting pure noise.
    peak = float(np.percentile(np.abs(audio), 99))
    if peak > 1e-4:
        audio = audio * min(0.7 / peak, 30.0)
    # Whisper expects 16 kHz; our audio is 8 kHz -> linear resample x2.
    if protocol.AUDIO_SAMPLE_RATE != WHISPER_SAMPLE_RATE:
        factor = WHISPER_SAMPLE_RATE / protocol.AUDIO_SAMPLE_RATE
        xp = np.arange(len(audio))
        x = np.linspace(0, len(audio) - 1, int(len(audio) * factor))
        audio = np.interp(x, xp, audio).astype(np.float32)
    model = WhisperModel(asr.model, device=asr.device)
    segments, info = model.transcribe(
        audio,
        language=asr.language,
        initial_prompt=INITIAL_PROMPT,
        vad_filter=True,
        # Default threshold 0.5 kills quiet/phone-quality speech even after
        # normalization (observed: a full 1.9 s utterance removed).
        vad_parameters=dict(_VAD_PARAMETERS),
    )
    text = " ".join(seg.text for seg in segments).strip()
    meta = {"language": getattr(info, "language", None)}
    return text, meta


# Silero VAD parameters, relaxed for quiet mic input.
_VAD_PARAMETERS = {
    "threshold": 0.3,
    "min_silence_duration_ms": 500,
    "speech_pad_ms": 200,
}


def detect_asr_status(asr: ASRConfig) -> dict:
    """Runtime ASR availability info for the dashboard.

    Everything lazy/defensive: faster-whisper may be absent, ctranslate2
    may not support CUDA. Never raises.
    """
    status: dict = {
        "engine": asr.engine,
        "model": asr.model,
        "device": asr.device,
        "installed": False,
        "version": None,
        "cuda_devices": None,
        # the pipeline always converts u8 PCM to normalized float32 [-1, 1]
        "peak_normalization": True,
        "note": "",
    }
    if asr.engine == "command":
        status["installed"] = bool(asr.command.strip())
        status["note"] = "external command" if status["installed"] else "no command configured"
        return status
    try:
        import importlib.metadata as md

        status["version"] = md.version("faster-whisper")
        status["installed"] = True
    except Exception:  # noqa: BLE001 - absent or broken install
        status["note"] = "pip install 'vibestick[asr]'"
        return status
    try:
        import ctranslate2

        status["cuda_devices"] = ctranslate2.get_cuda_device_count()
    except Exception:  # noqa: BLE001 - no GPU stack at all
        status["cuda_devices"] = None
    if asr.device == "cuda" and not status["cuda_devices"]:
        status["note"] = "device=cuda but no CUDA devices available"
    return status
