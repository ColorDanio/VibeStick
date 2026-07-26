"""Pure AUDIO routing contract shared by the host implementations.

The BLE protocol deliberately uses the same AUDIO characteristic for two
different product flows.  The distinction is made by ``voice.start``:
ordinary Agent CLI recording goes to ASR, while ``mode: \"mic\"`` goes to the
system Vibe Mic.  Keeping that decision here makes it testable without BLE,
PipeWire, or an ASR engine and gives the TypeScript implementation an exact
behavioural contract to conform to.
"""

from __future__ import annotations

from dataclasses import dataclass

ASR = "asr"
MIC = "mic"


@dataclass(frozen=True)
class RouteTransition:
    """The next AUDIO destination and side effects requested by a command."""

    route: str
    actions: tuple[str, ...] = ()


def transition(route: str, command: str, mode: object = None) -> RouteTransition:
    """Apply one voice command to an AUDIO route.

    Actions are intentionally declarative: the daemon owns process/pipeline
    objects, while this module owns product semantics.  Unknown commands are
    a no-op.  A normal recording start always reclaims AUDIO from a stale mic
    route left behind by a dropped BLE ``voice.stop``.
    """
    current = MIC if route == MIC else ASR

    if command == "voice.start":
        if mode == MIC:
            return RouteTransition(MIC, ("relay.start",))
        actions: tuple[str, ...] = ("asr.start",)
        if current == MIC:
            actions = ("relay.stop",) + actions
        return RouteTransition(ASR, actions)

    if command == "voice.stop":
        if current == MIC:
            return RouteTransition(ASR, ("relay.stop",))
        return RouteTransition(ASR, ("asr.stop",))

    if command == "voice.cancel":
        actions = ("asr.cancel",)
        if current == MIC:
            actions += ("relay.stop",)
        return RouteTransition(ASR, actions)

    return RouteTransition(current)
