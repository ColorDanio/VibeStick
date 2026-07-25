import json
import urllib.error
import urllib.request
import wave

import pytest

from vibestick import setupui, voice
from vibestick import config as config_mod
from vibestick.config import ASRConfig, Config, OnlineASRConfig


# -- openai_transcribe (mocked HTTP layer) --------------------------------------


class FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def read(self):
        return json.dumps(self._payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def make_cfg(**kw):
    base = {"api_base": "https://api.groq.com/openai/v1", "api_key": "gsk_test123456789", "model": "whisper-large-v3-turbo"}
    base.update(kw)
    return OnlineASRConfig(**base)


def test_transcribe_success_multipart(monkeypatch):
    seen = {}

    def fake_urlopen(req, timeout):
        seen["url"] = req.full_url
        seen["headers"] = dict(req.headers)
        seen["body"] = bytes(req.data)
        seen["timeout"] = timeout
        return FakeResponse({"text": "hello world"})

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    text, meta = voice.openai_transcribe(make_cfg(language="zh"), b"RIFFfake")
    assert text == "hello world"
    assert meta["language"] == "zh"
    assert seen["url"] == "https://api.groq.com/openai/v1/audio/transcriptions"
    assert seen["headers"]["Authorization"] == "Bearer gsk_test123456789"
    assert "multipart/form-data" in seen["headers"]["Content-type"]
    assert b'name="model"' in seen["body"]
    assert b"whisper-large-v3-turbo" in seen["body"]
    assert b'name="language"' in seen["body"] and b"zh" in seen["body"]
    assert b'filename="clip.wav"' in seen["body"]
    assert seen["timeout"] == voice.ONLINE_TIMEOUT_SEC


def test_transcribe_http_error_reason(monkeypatch):
    def raise_401(req, timeout):
        raise urllib.error.HTTPError(
            req.full_url, 401, "Unauthorized", {}, _BytesIO(b'{"error":{"message":"bad key"}}'))

    monkeypatch.setattr(urllib.request, "urlopen", raise_401)
    with pytest.raises(RuntimeError, match="HTTP 401"):
        voice.openai_transcribe(make_cfg(), b"RIFFfake")


class _BytesIO:
    def __init__(self, data):
        self._d = data

    def read(self, *a):
        return self._d


def test_transcribe_timeout_reason(monkeypatch):
    def raise_timeout(req, timeout):
        raise TimeoutError("timed out")

    monkeypatch.setattr(urllib.request, "urlopen", raise_timeout)
    with pytest.raises(RuntimeError, match="network error"):
        voice.openai_transcribe(make_cfg(), b"RIFFfake")


def test_transcribe_not_configured():
    with pytest.raises(RuntimeError, match="api_base"):
        voice._transcribe_online(ASRConfig(engine="online",
                                           online=OnlineASRConfig(api_base="", api_key="k")), b"\x80" * 10)
    with pytest.raises(RuntimeError, match="api_key"):
        voice._transcribe_online(ASRConfig(engine="online",
                                           online=OnlineASRConfig(api_key="")), b"\x80" * 10)


def test_engine_dispatch_online(tmp_path, monkeypatch):
    monkeypatch.setattr(voice, "openai_transcribe",
                        lambda cfg, wav: ("转写结果", {"language": None}))
    pipe = voice.VoicePipeline(
        ASRConfig(engine="online", online=make_cfg()),
        push=lambda s: None,
        transcription_log=voice.TranscriptionLog(path=tmp_path / "log.jsonl"),
        clips_dir=tmp_path / "clips",
    )
    import asyncio

    pipe.start()
    pipe.feed(b"\x90" * 800)
    asyncio.run(pipe.stop())
    entry = pipe.recent_transcriptions()[0]
    assert entry["state"] == "ok"
    assert entry["text"] == "转写结果"
    assert entry["engine"] == "online"
    assert entry["clip"] == "clip-1.wav"


# -- config: online sub-object, masking, perms ------------------------------------


def test_online_config_round_trip_and_mask():
    cfg = Config.from_dict({"tools": [{"id": "x"}], "asr": {
        "engine": "online",
        "online": {"api_base": "https://api.groq.com/openai/v1",
                   "api_key": "gsk_abcdefghijkl", "model": "whisper-large-v3-turbo",
                   "language": "auto"}}})
    assert cfg.asr.engine == "online"
    assert cfg.asr.online.language is None  # "auto" normalized
    d = cfg.to_dict()
    assert d["asr"]["online"]["api_key"] == "gsk_abcdefghijkl"  # full in file
    pub = cfg.asr.online.to_public_dict()
    assert pub["api_key"] == "gsk•••jkl"
    assert OnlineASRConfig(api_key="short").masked_key() == "•••"
    assert "online" in ASRConfig().to_dict()  # defaults present


def test_config_saved_0600(tmp_path):
    path = tmp_path / "config.json"
    config_mod.save(Config(tools=[config_mod.ToolConfig(id="x", name="X")]), path)
    assert (path.stat().st_mode & 0o777) == 0o600


def test_medium_model_allowed():
    cfg = ASRConfig.from_dict({"model": "medium"})
    assert cfg.model == "medium"
    assert ASRConfig.from_dict({"model": "huge"}).model == "small"  # coerced


# -- /api/asr/test endpoint ---------------------------------------------------------


@pytest.fixture
def server(tmp_path):
    srv, thread = setupui.serve_in_thread(tmp_path / "config.json", port=0)
    yield f"http://127.0.0.1:{srv.server_address[1]}", tmp_path
    srv.shutdown()
    srv.server_close()
    thread.join(timeout=5)


def post(url, body: bytes):
    import urllib.request as ur
    req = ur.Request(url, data=body, method="POST")
    try:
        with ur.urlopen(req, timeout=10) as res:
            return res.status, json.loads(res.read())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read())


def make_clip(clips_dir, name="clip-1.wav"):
    clips_dir.mkdir(parents=True, exist_ok=True)
    with wave.open(str(clips_dir / name), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(1)
        w.setframerate(8000)
        w.writeframes(b"\x90" * 800)


def test_asr_test_endpoint_success(server, monkeypatch):
    base, tmp_path = server
    clips = tmp_path / "clips"
    make_clip(clips)
    monkeypatch.setattr(voice, "test_online_transcription",
                        lambda cfg, wav: {"ok": True, "text": "hi", "latency_ms": 42})
    status, data = post(base + "/api/asr/test", json.dumps({
        "engine": "online", "clips_dir": str(clips),
        "online": {"api_base": "https://x", "api_key": "k", "model": "m"},
    }).encode())
    assert status == 200
    assert data == {"ok": True, "text": "hi", "latency_ms": 42, "clip": "clip-1.wav"}


def test_asr_test_endpoint_no_clips(server):
    base, tmp_path = server
    status, data = post(base + "/api/asr/test", json.dumps({
        "engine": "online", "clips_dir": str(tmp_path / "empty"),
        "online": {"api_base": "https://x", "api_key": "k", "model": "m"},
    }).encode())
    assert status == 200
    assert data["ok"] is False
    assert "no clips" in data["error"]


def test_asr_test_endpoint_rejects_other_engines(server):
    base, _ = server
    status, data = post(base + "/api/asr/test", json.dumps({"engine": "command"}).encode())
    assert status == 400
    assert "online" in data["error"]


def test_config_api_masks_and_preserves_key(server):
    base, tmp_path = server
    cfg = Config.from_dict({"tools": [{"id": "x"}], "asr": {
        "engine": "online",
        "online": {"api_base": "https://x", "api_key": "gsk_abcdefghijkl", "model": "m"}}})
    config_mod.save(cfg, tmp_path / "config.json")
    import urllib.request as ur

    data = json.loads(ur.urlopen(base + "/api/config", timeout=5).read())
    assert data["asr"]["online"]["api_key"] == "gsk•••jkl"  # masked in GET
    # POST the masked value back -> stored key preserved
    status, _ = post(base + "/api/config", json.dumps(data).encode())
    assert status == 200
    reloaded = config_mod.load(tmp_path / "config.json")
    assert reloaded.asr.online.api_key == "gsk_abcdefghijkl"
    # POST a NEW key -> replaced
    data["asr"]["online"]["api_key"] = "new-key-999"
    post(base + "/api/config", json.dumps(data).encode())
    assert config_mod.load(tmp_path / "config.json").asr.online.api_key == "new-key-999"
