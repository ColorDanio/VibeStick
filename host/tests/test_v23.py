import asyncio
import json
import math
import time

import pytest

from vibestick import discover, voice
from vibestick.config import ASRConfig
from vibestick.discover import _clean_message_text, _sanitize_text
from vibestick.voice import TranscriptionLog, VoicePipeline


def pcm_sine(seconds=1.0, amp=4, rate=8000, freq=200):
    """Low-amplitude u8 PCM (quiet mic), speech-like bursts."""
    return bytes(
        int(128 + amp * math.sin(2 * math.pi * freq * i / rate)) & 0xFF
        for i in range(int(rate * seconds))
    )


# -- TranscriptionLog ----------------------------------------------------------


def test_transcription_log_ring_and_file(tmp_path):
    log_path = tmp_path / "voice-log.jsonl"
    tlog = TranscriptionLog(path=log_path, maxlen=3)
    for i in range(5):
        tlog.record({"duration_sec": 1.0, "engine": "faster-whisper",
                     "state": "ok", "text": f"t{i}"})
    recent = tlog.recent()
    assert [e["text"] for e in recent] == ["t4", "t3", "t2"]  # newest first, capped
    lines = log_path.read_text().strip().splitlines()
    assert len(lines) == 5
    assert json.loads(lines[-1])["text"] == "t4"
    assert "ts" in json.loads(lines[0])


def make_pipeline(tmp_path, transcriber):
    tlog = TranscriptionLog(path=tmp_path / "log.jsonl")
    pushed = []
    pipe = VoicePipeline(
        ASRConfig(engine="command", command="unused"),
        push=pushed.append,
        transcriber=transcriber,
        transcription_log=tlog,
    )
    return pipe, tlog


def run(pipe, seconds=1.0):
    pipe.start()
    pipe.feed(pcm_sine(seconds))
    asyncio.run(pipe.stop())


def test_pipeline_records_ok(tmp_path):
    pipe, tlog = make_pipeline(tmp_path, lambda pcm: "hello world")
    run(pipe, 2.0)
    (entry,) = tlog.recent()
    assert entry["state"] == "ok"
    assert entry["text"] == "hello world"
    assert entry["duration_sec"] == 2.0
    assert entry["engine"] == "command"


def test_pipeline_records_no_speech_and_too_short(tmp_path):
    pipe, tlog = make_pipeline(tmp_path, lambda pcm: "  ")
    run(pipe, 1.5)
    assert tlog.recent()[0]["state"] == "no-speech"
    assert "VAD" in tlog.recent()[0]["reason"]
    pipe2, tlog2 = make_pipeline(tmp_path, lambda pcm: "")
    run(pipe2, 0.1)
    assert tlog2.recent()[0]["reason"] == "too short"


def test_pipeline_records_error_reason(tmp_path):
    def boom(pcm):
        raise RuntimeError("model exploded")

    pipe, tlog = make_pipeline(tmp_path, boom)
    run(pipe)
    entry = tlog.recent()[0]
    assert entry["state"] == "error"
    assert "model exploded" in entry["reason"]


# -- VAD / normalization ----------------------------------------------------------


class FakeWhisperModel:
    captured = {}

    def __init__(self, model, device):
        FakeWhisperModel.captured["init"] = (model, device)

    def transcribe(self, audio, **kwargs):
        FakeWhisperModel.captured["audio"] = audio
        FakeWhisperModel.captured["kwargs"] = kwargs
        return [type("Seg", (), {"text": "ok"})()], None


def test_faster_whisper_normalizes_and_relaxes_vad(monkeypatch):
    pytest.importorskip("numpy")
    import numpy as np

    monkeypatch.setattr("faster_whisper.WhisperModel", FakeWhisperModel)
    FakeWhisperModel.captured = {}
    # quiet speech (amp 4) + one loud click at the start (would ruin max-peak gain)
    pcm = bytes([255] * 10) + pcm_sine(1.9, amp=4)
    text, meta = voice._transcribe_faster_whisper(
        ASRConfig(engine="faster-whisper", model="base", device="cpu"), pcm)
    assert text == "ok"
    audio = FakeWhisperModel.captured["audio"]
    kwargs = FakeWhisperModel.captured["kwargs"]
    assert kwargs.get("initial_prompt") == voice.INITIAL_PROMPT
    # resampled 8k -> 16k (x2)
    assert len(audio) == 2 * len(pcm)
    # 99th-percentile peak normalized to 0.7 despite the click
    assert abs(float(np.percentile(np.abs(audio), 99)) - 0.7) < 0.05
    # relaxed VAD parameters passed through
    vad = kwargs.get("vad_parameters")
    assert vad is not None
    assert vad["threshold"] == 0.25
    assert kwargs["vad_filter"] is True


def test_faster_whisper_click_does_not_suppress_gain(monkeypatch):
    pytest.importorskip("numpy")
    import numpy as np

    monkeypatch.setattr("faster_whisper.WhisperModel", FakeWhisperModel)
    FakeWhisperModel.captured = {}
    voice._transcribe_faster_whisper(ASRConfig(), pcm_sine(1.0, amp=4))
    audio = FakeWhisperModel.captured["audio"]
    assert float(np.max(np.abs(audio))) > 0.5  # quiet speech boosted, not left at 0.03


# -- tail sanitizer -------------------------------------------------------------


def test_sanitize_strips_tags_markdown_urls():
    assert _sanitize_text("<b>bold</b> and `code`") == "bold and code"
    assert _sanitize_text("**Milestone** ## done") == "Milestone done"
    assert _sanitize_text("see https://example.com/a/b?c=d for details") == "see [link] for details"
    assert _sanitize_text("read [TASK.md](/home/u/x/TASK.md) now") == "read TASK.md now"
    assert _sanitize_text("<system-reminder>x</system-reminder> real text") == "x real text"
    assert _sanitize_text("a   lot    of\n\nspace") == "a lot of space"


def test_clean_message_html_in_to_clean_out():
    assert _clean_message_text("<div class='x'>hello <span>world</span></div>") == "hello world"
    # noise injections still rejected
    assert _clean_message_text("<system-reminder>blob</system-reminder>") is None
    assert _clean_message_text("<environment_context>cwd</environment_context>") is None


def test_sanitizer_applies_to_all_sources(tmp_path):
    """Each source's extractor routes through the same sanitizer."""
    for fn in (discover._claude_msg, discover._codex_msg, discover._kimi_msg):
        if fn is discover._claude_msg:
            entry = {"type": "assistant", "message": {"content": [
                {"type": "text", "text": "**Done** <b>now</b>"}]}}
        elif fn is discover._codex_msg:
            entry = {"payload": {"type": "message", "role": "assistant",
                                 "content": [{"type": "output_text", "text": "**Done** <b>now</b>"}]}}
        else:
            entry = {"type": "context.append_message", "message": {
                "role": "assistant", "content": [{"type": "text", "text": "**Done** <b>now</b>"}]}}
        role, text = fn(entry)
        assert text == "Done now"
