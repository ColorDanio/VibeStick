"""Conformance tests for the language-neutral host contracts in contracts/v1."""

from __future__ import annotations

import json
from pathlib import Path

from vibestick.config import Config
from vibestick.hid import keycodes_from_report
from vibestick.protocol import SessionStatus, SessionsPayload
from vibestick.routing import transition

CONTRACTS = Path(__file__).parents[2] / "contracts" / "v1"


def load(name: str) -> dict:
    data = json.loads((CONTRACTS / name).read_text(encoding="utf-8"))
    assert data["version"] == 1
    return data


def test_config_normalization_contract():
    fixture = load("config-normalization.json")
    assert Config.from_dict(fixture["input"]).to_dict() == fixture["expected"]


def test_status_payload_contract():
    fixture = load("status-payload.json")
    status = SessionStatus.from_dict(fixture["input"])
    assert status.to_dict() == fixture["expected"]
    assert json.loads(status.to_json()) == fixture["expected"]


def test_sessions_payload_contract():
    fixture = load("sessions-payload.json")
    payload = SessionsPayload.from_dict(fixture["input"])
    assert payload.to_dict() == fixture["expected"]
    assert json.loads(payload.to_json()) == fixture["expected"]


def test_voice_routing_contract():
    fixture = load("voice-routing.json")
    route = fixture["initial_route"]
    for event in fixture["events"]:
        result = transition(route, event["command"], event.get("mode"))
        expected = event["expected"]
        assert result.route == expected["route"]
        assert list(result.actions) == expected["actions"]
        assert result.route == expected["audio_destination"]
        route = result.route


def test_hid_reports_contract():
    fixture = load("hid-reports.json")
    for report in fixture["reports"]:
        parsed = keycodes_from_report(bytes.fromhex(report["hex"]))
        expected = report["expected_keycodes"]
        assert (None if parsed is None else sorted(parsed)) == expected, report["name"]
