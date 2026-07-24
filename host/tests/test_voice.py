import asyncio
import json

from vibestick import voice
from vibestick.config import ASRConfig
from vibestick.voice import VoicePipeline


def make_pipeline(**kwargs):
    pushed = []
    delivered = []
    pipe = VoicePipeline(
        ASRConfig(engine="command", command="unused"),
        push=pushed.append,
        deliver=delivered.append,
        transcriber=kwargs.pop("transcriber", lambda pcm: f"len={len(pcm)}"),
        **kwargs,
    )
    return pipe, pushed, delivered


def states(pushed):
    return [json.loads(p)["state"] for p in pushed]


def pcm(seconds=1.0, value=160):
    return bytes([value]) * int(8000 * seconds)


def test_record_stop_ready_confirm():
    pipe, pushed, delivered = make_pipeline()
    pipe.feed(pcm(0.1))  # ignored: not recording
    pipe.start()
    assert json.loads(pushed[-1]) == {"state": "recording", "text": ""}

    pipe.feed(pcm(0.5))
    pipe.feed(pcm(0.25))
    asyncio.run(pipe.stop())
    assert states(pushed) == ["recording", "transcribing", "ready"]
    ready = json.loads(pushed[-1])
    assert ready["text"] == "len=6000"  # 0.75s * 8000 samples

    pipe.confirm()
    assert delivered == ["len=6000"]
    assert json.loads(pushed[-1])["state"] == "idle"


def test_cancel_discards():
    pipe, pushed, delivered = make_pipeline()
    pipe.start()
    pipe.feed(pcm(0.5))
    pipe.cancel()
    assert pipe.state == "idle"
    assert json.loads(pushed[-1])["state"] == "idle"
    asyncio.run(pipe.stop())  # no-op outside recording
    assert states(pushed) == ["recording", "idle"]
    assert delivered == []


def test_confirm_only_in_ready_state():
    pipe, pushed, delivered = make_pipeline()
    pipe.confirm()  # no-op
    assert delivered == []
    pipe.start()
    pipe.feed(pcm(0.1))
    asyncio.run(pipe.stop())
    pipe.cancel()
    pipe.confirm()  # nothing ready anymore
    assert delivered == []


def test_empty_transcript_is_error():
    pipe, pushed, _ = make_pipeline(transcriber=lambda pcm: "  ")
    pipe.start()
    pipe.feed(pcm(0.1))
    asyncio.run(pipe.stop())
    last = json.loads(pushed[-1])
    assert last["state"] == "error"
    assert last["text"] == "no speech detected"


def test_transcriber_failure_is_error():
    def boom(pcm):
        raise RuntimeError("asr exploded")

    pipe, pushed, _ = make_pipeline(transcriber=boom)
    pipe.start()
    pipe.feed(pcm(0.1))
    asyncio.run(pipe.stop())
    last = json.loads(pushed[-1])
    assert last["state"] == "error"
    assert "asr exploded" in last["text"]


def test_buffer_capped_at_max_duration():
    pipe, pushed, _ = make_pipeline(max_duration_sec=1)
    pipe.start()
    pipe.feed(pcm(2.0))  # 2s into a 1s buffer
    asyncio.run(pipe.stop())
    assert json.loads(pushed[-1])["text"] == "len=8000"


def test_frames_ignored_outside_recording():
    pipe, _, _ = make_pipeline()
    pipe.feed(pcm(1.0))
    assert pipe._buf == bytearray()


def test_command_engine_runs_template(tmp_path):
    script = tmp_path / "fake_asr.sh"
    script.write_text('#!/bin/sh\ntest -f "$1" || exit 1\necho "hello from wav"\n')
    script.chmod(0o755)
    pushed = []
    pipe = VoicePipeline(
        ASRConfig(engine="command", command=f"sh {script}"),
        push=pushed.append,
    )
    pipe.start()
    pipe.feed(pcm(0.1))
    asyncio.run(pipe.stop())
    last = json.loads(pushed[-1])
    assert last == {"state": "ready", "text": "hello from wav"}


def test_command_engine_failure(tmp_path):
    pushed = []
    pipe = VoicePipeline(
        ASRConfig(engine="command", command="false"),
        push=pushed.append,
    )
    pipe.start()
    pipe.feed(pcm(0.1))
    asyncio.run(pipe.stop())
    assert json.loads(pushed[-1])["state"] == "error"


def test_faster_whisper_missing_dependency_graceful(monkeypatch):
    def no_numpy(asr, pcm):
        raise RuntimeError("faster-whisper/numpy not installed")

    monkeypatch.setattr(voice, "_transcribe_faster_whisper", no_numpy)
    pushed = []
    pipe = VoicePipeline(ASRConfig(engine="faster-whisper"), push=pushed.append)
    pipe.start()
    pipe.feed(pcm(0.1))
    asyncio.run(pipe.stop())
    last = json.loads(pushed[-1])
    assert last["state"] == "error"
    assert "not installed" in last["text"]


def test_pcm_to_wav_header(tmp_path):
    import wave as wave_mod

    path = tmp_path / "out.wav"
    voice.pcm_to_wav(pcm(0.5), path)
    with wave_mod.open(str(path), "rb") as w:
        assert w.getframerate() == 8000
        assert w.getsampwidth() == 1
        assert w.getnchannels() == 1
        assert w.getnframes() == 4000
        assert w.readframes(4000) == pcm(0.5)
