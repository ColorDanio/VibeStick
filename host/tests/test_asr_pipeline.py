import asyncio
import json
import math
import sys

import pytest

from vibestick import voice
from vibestick.config import ASRConfig
from vibestick.voice import TranscriptionLog, VoicePipeline


def pcm_sine(seconds=1.0, amp=4, rate=8000, freq=200, dc=0):
    return bytes(
        max(0, min(255, int(128 + dc + amp * math.sin(2 * math.pi * freq * i / rate))))
        for i in range(int(rate * seconds))
    )


# -- clip rotation -----------------------------------------------------------


def make_pipeline(tmp_path, clips_dir):
    tlog = TranscriptionLog(path=tmp_path / "log.jsonl")
    return VoicePipeline(
        ASRConfig(engine="command", command="unused"),
        push=lambda s: None,
        transcriber=lambda pcm: "text",
        transcription_log=tlog,
        clips_dir=clips_dir,
    ), tlog


def test_clips_saved_and_rotated(tmp_path):
    clips = tmp_path / "clips"
    pipe, tlog = make_pipeline(tmp_path, clips)
    for i in range(7):
        pipe.start()
        pipe.feed(pcm_sine(0.5))
        asyncio.run(pipe.stop())
    names = sorted(p.name for p in clips.iterdir())
    assert names == [f"clip-{i}.wav" for i in range(1, 6)]  # only 5 kept
    entries = tlog.recent()
    assert entries[0]["clip"] == "clip-2.wav"  # 7th recording wraps around
    assert entries[1]["clip"] == "clip-1.wav"
    assert (clips / "clip-2.wav").stat().st_mtime >= (clips / "clip-1.wav").stat().st_mtime


def test_clips_disabled(tmp_path):
    pipe, tlog = make_pipeline(tmp_path, None)
    pipe.start()
    pipe.feed(pcm_sine(0.5))
    asyncio.run(pipe.stop())
    assert tlog.recent()[0].get("clip", "") == ""


# -- audio preprocessing -------------------------------------------------------


def test_prepare_audio_pipeline():
    np = pytest.importorskip("numpy")
    pcm = pcm_sine(1.0, amp=4, dc=20)  # quiet speech + DC offset
    audio = voice._prepare_audio(pcm)
    assert len(audio) == 2 * len(pcm)  # 8k -> 16k polyphase x2
    assert abs(float(np.mean(audio))) < 0.02  # DC removed
    assert abs(float(np.percentile(np.abs(audio), 99)) - 0.7) < 0.05  # p99 normalized


def test_resample_fallback_without_scipy(monkeypatch):
    pytest.importorskip("numpy")
    import numpy as np

    monkeypatch.setitem(sys.modules, "scipy.signal", None)  # force ImportError
    audio = (np.frombuffer(pcm_sine(0.5), dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    out = voice._resample(audio, 8000, 16000)
    assert len(out) == 2 * len(audio)  # linear interpolation fallback still works


# -- decode parameters -----------------------------------------------------------


class FakeWhisperModel:
    captured = {}

    def __init__(self, model, device):
        pass

    def transcribe(self, audio, **kwargs):
        FakeWhisperModel.captured["kwargs"] = kwargs
        seg = type("Seg", (), {"text": "ok"})()
        info = type("Info", (), {"language": "zh"})()
        return [seg], info


def test_decode_parameters_hardened(monkeypatch):
    pytest.importorskip("numpy")
    monkeypatch.setattr("faster_whisper.WhisperModel", FakeWhisperModel)
    text, meta = voice._transcribe_faster_whisper(ASRConfig(model="small"), pcm_sine(1.0))
    assert text == "ok"
    assert meta["language"] == "zh"
    kw = FakeWhisperModel.captured["kwargs"]
    assert kw["condition_on_previous_text"] is False
    assert kw["no_speech_threshold"] == 0.6
    assert kw["log_prob_threshold"] == -1.0
    assert kw["compression_ratio_threshold"] == 2.4
    assert kw["temperature"] == 0
    assert kw["beam_size"] == 5
    assert kw["initial_prompt"] == voice.INITIAL_PROMPT
    assert kw["vad_parameters"]["threshold"] == 0.25


def test_voice_log_carries_clip_and_language(tmp_path):
    pytest.importorskip("numpy")
    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr("faster_whisper.WhisperModel", FakeWhisperModel)
    tlog = TranscriptionLog(path=tmp_path / "log.jsonl")
    pipe = VoicePipeline(
        ASRConfig(engine="faster-whisper", model="small"),
        push=lambda s: None,
        transcription_log=tlog,
        clips_dir=tmp_path / "clips",
    )
    pipe.start()
    pipe.feed(pcm_sine(1.0))
    asyncio.run(pipe.stop())
    entry = tlog.recent()[0]
    assert entry["state"] == "ok"
    assert entry["language"] == "zh"
    assert entry["model"] == "small"
    assert entry["clip"] == "clip-1.wav"
    assert entry["processing_sec"] >= 0
