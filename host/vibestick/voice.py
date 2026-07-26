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
import re
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
CLIPS_DIR = Path.home() / ".vibestick" / "clips"
RECENT_TRANSCRIPTIONS = 20
SAVED_CLIPS = 5

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
        clips_dir: Path | str | None = CLIPS_DIR,
    ) -> None:
        self.asr = asr
        self._push = push
        self._deliver = deliver
        self._transcriber = transcriber
        self.max_duration_sec = max_duration_sec
        self._tlog = transcription_log
        self._clips_dir = Path(clips_dir) if clips_dir else None
        self._clip_seq = 0
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
        clip = self._save_clip(pcm)
        self._set_state("transcribing")
        started = time.monotonic()
        meta: dict = {}
        try:
            text, meta = await asyncio.to_thread(self._transcribe, pcm)
        except Exception as exc:  # noqa: BLE001 - any ASR failure -> error state
            reason = _summarize_exc(exc)
            log.warning("transcription failed: %s", exc)
            self._record_attempt(duration, "error", reason=reason, clip=clip,
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
            self._record_attempt(duration, "no-speech", reason=reason, clip=clip,
                                 processing_sec=elapsed, meta=meta)
            self._set_state("error", "no speech detected")
            return
        self._record_attempt(duration, "ok", text=text, clip=clip,
                             processing_sec=elapsed, meta=meta)
        self.transcript = text
        self._set_state("ready", text)

    def recent_transcriptions(self) -> list[dict]:
        return self._tlog.recent() if self._tlog is not None else []

    def _record_attempt(self, duration: float, state: str,
                        text: str = "", reason: str = "", clip: str = "",
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
        if clip:
            entry["clip"] = clip
        if text:
            entry["text"] = text[:120]
        if reason:
            entry["reason"] = reason
        self._tlog.record(entry)

    def _save_clip(self, pcm: bytes) -> str:
        """Persist the recording as a rotating clip-N.wav; returns the name."""
        if self._clips_dir is None or not pcm:
            return ""
        try:
            self._clips_dir.mkdir(parents=True, exist_ok=True)
            name = f"clip-{self._clip_seq % SAVED_CLIPS + 1}.wav"
            self._clip_seq += 1
            pcm_to_wav(pcm, self._clips_dir / name)
            return name
        except OSError as exc:
            log.debug("clip save failed: %s", exc)
            return ""

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
        if self.asr.engine == "online":
            return _transcribe_online(self.asr, pcm)
        return _transcribe_faster_whisper(self.asr, pcm)


def pcm_to_wav(pcm: bytes, path) -> None:
    """Write 8 kHz 8-bit unsigned mono PCM as a WAV file (path or file object)."""
    with wave.open(path if hasattr(path, "write") else str(path), "wb") as w:
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
INITIAL_PROMPT = (
    "Hello. 你好。以下是简体中文和英文混合的语音转写。"
    "产品词包括 VibeStick、YOLO、Vibe Mic、Agent CLI、Codex、OpenCode、Kimi CLI。"
)

# Whisper small commonly phoneticizes the spoken acronym "YOLO" as a Chinese
# word. Only normalize the variants in product-command contexts, so ordinary
# Chinese sentences containing a similar sounding word remain unchanged.
_YOLO_HOMOPHONE = re.compile(
    r"(?:游漏|优劳|优努|优龙|游罗|优罗)(?=(?:模式|输入|功能)(?:[。！？，, ]|$))"
)


def normalize_product_terms(text: str) -> str:
    """Normalize unambiguous VibeStick product terms after ASR decoding."""
    return _YOLO_HOMOPHONE.sub("YOLO", text)


def _highpass(audio):
    """First-order DC blocker (scipy preferred; DC subtraction already done)."""
    try:
        from scipy.signal import lfilter

        return lfilter([1.0, -1.0], [1.0, -0.995], audio)
    except ImportError:
        return audio


def _resample(audio, src_rate: int, dst_rate: int):
    """Polyphase resampling (scipy); falls back to linear interpolation."""
    if src_rate == dst_rate:
        return audio
    try:
        from math import gcd

        from scipy.signal import resample_poly

        g = gcd(dst_rate, src_rate)
        return resample_poly(audio, dst_rate // g, src_rate // g)
    except ImportError:
        import numpy as np

        factor = dst_rate / src_rate
        xp = np.arange(len(audio))
        x = np.linspace(0, len(audio) - 1, int(len(audio) * factor))
        return np.interp(x, xp, audio).astype(np.float32)


def _prepare_audio(pcm: bytes):
    """u8 8 kHz PCM -> float32 mono 16 kHz: DC removal, first-order
    high-pass, polyphase resample, p99 peak normalization."""
    import numpy as np

    audio = (np.frombuffer(pcm, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    if len(audio) == 0:
        return audio
    audio = audio - float(np.mean(audio))  # DC offset removal
    audio = _highpass(audio)
    audio = _resample(audio, protocol.AUDIO_SAMPLE_RATE, WHISPER_SAMPLE_RATE)
    # The stick's PDM mic is quiet; peak-normalize so whisper's VAD can
    # detect normal speech. 99th percentile keeps single clicks from
    # suppressing the gain; the cap avoids boosting pure noise.
    peak = float(np.percentile(np.abs(audio), 99))
    if peak > 1e-4:
        audio = audio * min(0.7 / peak, 30.0)
    return audio.astype(np.float32)


# Anti-hallucination decode settings for short PTT utterances.
_DECODE_PARAMETERS = {
    "condition_on_previous_text": False,
    "no_speech_threshold": 0.6,
    "log_prob_threshold": -1.0,
    "compression_ratio_threshold": 2.4,
    "temperature": 0,
    "beam_size": 5,
}


def _transcribe_faster_whisper(asr: ASRConfig, pcm: bytes) -> tuple[str, dict]:
    """Transcribe with faster-whisper (optional dependency, imported lazily).

    Returns (text, meta) with meta["language"] = detected language code.
    """
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise RuntimeError(
            "faster-whisper/numpy not installed; run: pip install 'vibestick[asr]'"
        ) from exc
    audio = _prepare_audio(pcm)
    if len(audio) == 0:
        return "", {}
    model = WhisperModel(asr.model, device=asr.device)
    segments, info = model.transcribe(
        audio,
        language=asr.language,
        initial_prompt=INITIAL_PROMPT,
        vad_filter=True,
        # Default threshold 0.5 kills quiet/phone-quality speech even after
        # normalization (observed: a full 1.9 s utterance removed).
        vad_parameters=dict(_VAD_PARAMETERS),
        **dict(_DECODE_PARAMETERS),
    )
    text = normalize_product_terms(" ".join(seg.text for seg in segments).strip())
    meta = {"language": getattr(info, "language", None)}
    return text, meta


# Silero VAD parameters, relaxed for quiet mic input.
_VAD_PARAMETERS = {
    "threshold": 0.25,
    "min_silence_duration_ms": 500,
    "speech_pad_ms": 300,
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
    if asr.engine == "online":
        from urllib.parse import urlparse

        status["installed"] = bool(asr.online.api_base.strip() and asr.online.api_key.strip())
        status["model"] = asr.online.model
        status["provider"] = urlparse(asr.online.api_base).netloc or asr.online.api_base
        status["note"] = status["provider"] if status["installed"] else "api_base/api_key not configured"
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


# -- online engine (OpenAI-compatible transcription API) -----------------------

ONLINE_TIMEOUT_SEC = 30


def _wav_bytes(pcm: bytes) -> bytes:
    """The raw recording as a WAV document (8 kHz u8 mono, no re-encode)."""
    import io

    buf = io.BytesIO()
    pcm_to_wav(pcm, buf)
    return buf.getvalue()


def _transcribe_online(asr: ASRConfig, pcm: bytes) -> tuple[str, dict]:
    """Transcribe via an OpenAI-compatible /audio/transcriptions endpoint."""
    cfg = asr.online
    if not cfg.api_base.strip():
        raise RuntimeError("online asr: api_base not configured")
    if not cfg.api_key.strip():
        raise RuntimeError("online asr: api_key not configured")
    return openai_transcribe(cfg, _wav_bytes(pcm))


def openai_transcribe(cfg, wav_bytes: bytes) -> tuple[str, dict]:
    """POST multipart to {api_base}/audio/transcriptions (OpenAI/Groq/
    SiliconFlow/DeepInfra compatible). Raises RuntimeError with a
    readable reason on auth/rate-limit/network failures."""
    import io
    import urllib.error
    import urllib.request
    import uuid

    boundary = "vibestick-" + uuid.uuid4().hex

    def field(name: str, value: str) -> bytes:
        return (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'
            f"{value}\r\n"
        ).encode()

    body = bytearray()
    body += field("model", cfg.model)
    if cfg.language:
        body += field("language", cfg.language)
    body += (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="file"; filename="clip.wav"\r\n'
        "Content-Type: audio/wav\r\n\r\n"
    ).encode()
    body += wav_bytes
    body += f"\r\n--{boundary}--\r\n".encode()

    url = cfg.api_base.rstrip("/") + "/audio/transcriptions"
    req = urllib.request.Request(
        url,
        data=bytes(body),
        headers={
            "Authorization": f"Bearer {cfg.api_key}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=ONLINE_TIMEOUT_SEC) as resp:
            payload = json.loads(resp.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as exc:
        snippet = ""
        try:
            snippet = exc.read().decode("utf-8", errors="replace")[:200]
        except Exception:  # noqa: BLE001
            pass
        raise RuntimeError(f"online asr HTTP {exc.code}: {snippet or exc.reason}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise RuntimeError(f"online asr network error: {exc}") from exc
    text = str(payload.get("text", "")).strip()
    return text, {"language": cfg.language}


def test_online_transcription(cfg, wav_bytes: bytes) -> dict:
    """Dashboard 'Test' button: transcribe a clip, report latency/errors."""
    start = time.monotonic()
    try:
        text, meta = openai_transcribe(cfg, wav_bytes)
    except RuntimeError as exc:
        return {"ok": False, "error": str(exc), "latency_ms": int((time.monotonic() - start) * 1000)}
    return {
        "ok": True,
        "text": text,
        "language": meta.get("language"),
        "latency_ms": int((time.monotonic() - start) * 1000),
    }
