import asyncio

import pytest

from vibestick import delivery
from vibestick.delivery import map_binding, send_binding


@pytest.mark.parametrize(
    "binding,expected_args,expected_literal",
    [
        ("ctrl-c", ["C-c"], False),
        ("C-c", ["C-c"], False),  # tmux-style passes through
        ("escape", ["Escape"], False),
        ("enter", ["Enter"], False),
        ("Enter", ["Enter"], False),
        ("ctrl-enter", ["C-Enter"], False),
        ("ctrl-shift-tab", ["C-S-Tab"], False),
        ("alt-x", ["M-x"], False),
        ("f5", ["F5"], False),
        ("x", ["x"], False),  # single char is a key
        ("yes", ["yes"], True),  # literal string
        (":wq", [":wq"], True),
    ],
)
def test_map_binding(binding, expected_args, expected_literal):
    args, literal = map_binding(binding)
    assert args == expected_args
    assert literal == expected_literal


class FakeProc:
    def __init__(self, returncode=0, stderr=b""):
        self.returncode = returncode
        self._stderr = stderr

    async def communicate(self):
        return (b"", self._stderr)


@pytest.fixture
def record_tmux(monkeypatch):
    calls = []

    async def fake_exec(*argv, **kwargs):
        calls.append(argv)
        return FakeProc()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    return calls


def run(coro):
    return asyncio.run(coro)


def test_send_binding_ctrl_c(record_tmux):
    ok = run(send_binding({"tmux": "%3"}, "ctrl-c"))
    assert ok is True
    assert record_tmux[0] == ("tmux", "send-keys", "-t", "%3", "--", "C-c")


def test_send_binding_enter(record_tmux):
    ok = run(send_binding({"tmux": "%3"}, "enter"))
    assert ok is True
    assert record_tmux[0] == ("tmux", "send-keys", "-t", "%3", "--", "Enter")


def test_send_binding_literal_uses_dash_l(record_tmux):
    ok = run(send_binding({"tmux": "%3"}, "yes, continue"))
    assert ok is True
    assert record_tmux[0] == ("tmux", "send-keys", "-t", "%3", "-l", "--", "yes, continue")


def test_send_binding_no_delivery_method():
    assert run(send_binding({}, "ctrl-c")) is False
    assert run(send_binding(None, "ctrl-c")) is False
    assert run(send_binding({"tmux": "%1"}, "")) is False


def test_send_binding_tmux_failure(monkeypatch):
    async def fake_exec(*argv, **kwargs):
        return FakeProc(returncode=1, stderr=b"no pane")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    assert run(send_binding({"tmux": "%9"}, "ctrl-c")) is False


def test_send_binding_tmux_missing_binary(monkeypatch):
    async def fake_exec(*argv, **kwargs):
        raise FileNotFoundError("tmux")

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    assert run(send_binding({"tmux": "%9"}, "ctrl-c")) is False
