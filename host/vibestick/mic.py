"""Virtual microphone: route device MIC-mode PCM into a PipeWire source.

The firmware's MIC mode (voice.start with "mode":"mic") streams raw PCM
(8 kHz, 8-bit unsigned, mono) over AUDIO; this module turns it into a
system microphone any app (openwhispr, ChatGPT desktop, ...) can select.

Verified recipe on PipeWire 1.6 (see host/README.md):

- one persistent `null-audio-sink` adapter node with
  `media.class=Audio/Source/Virtual` — apps see an `Audio/Source` named
  "Vibe Mic"; audio written to its input ports is mirrored to its
  capture ports (dsp monitor), which is what apps record from;
- per PTT session, a `pw-cat --playback --raw` feeder (uniquely named
  stream, no auto-target) reads PCM from stdin and is linked into the
  mic node's input ports with `pw-link`. No data on stdin = silence.

Everything is best-effort: missing binaries or crashing subprocesses
degrade to log messages, never exceptions. ASR-mode audio never touches
this path (routing lives in the daemon).
"""

from __future__ import annotations

import asyncio
import json
import logging

log = logging.getLogger(__name__)

NODE_NAME = "vibe-mic"
NODE_DESC = "Vibe Mic"
FEED_STREAM = "vibestick-mic-feed"
# A previous release used this node name.  Adapter nodes linger by design, so
# remove the obsolete source once when the daemon starts; otherwise desktop
# apps show both names and users can accidentally select the dead one.
LEGACY_NODE_NAMES = ("vibestick-mic",)

CREATE_ARGV = [
    "pw-cli", "create-node", "adapter",
    "{ factory.name=support.null-audio-sink"
    f" node.name={NODE_NAME}"
    f' node.description="{NODE_DESC}"'
    # Audio/Source/Virtual gives both feed (input_*) and monitor
    # (capture_*) ports; the device.* props are what GNOME Settings
    # needs to list the source in its input devices.
    " media.class=Audio/Source/Virtual"
    f' device.description="{NODE_DESC}"'
    " device.class=sound"
    " node.virtual=true"
    " audio.position=[ FL FR ]"
    " node.always-process=true"
    " node.suspend-on-idle=false"
    " adapter.auto-port-config={ mode=dsp monitor=true position=preserve }"
    " object.linger=true }",
]

FEEDER_ARGV = [
    "pw-cat", "--playback",
    "-P", f"node.name={FEED_STREAM}",
    "--target", "0",  # no auto-link; we wire the ports ourselves
    "--raw", "--rate", "8000", "--format", "u8", "--channels", "1",
    "--channel-map", "MONO",
    "-",  # read PCM from stdin
]

STOP_TIMEOUT_SEC = 3.0
LINK_TIMEOUT_SEC = 3.0


MIC_GAIN = 3.0  # software gain on u8 PCM (monitors/resampling eat ~10-25 dB)


def _apply_gain(data: bytes, gain: float = MIC_GAIN) -> bytes:
    if gain == 1.0:
        return data
    return bytes(
        max(0, min(255, int(128 + (b - 128) * gain))) for b in data
    )


class MicRelay:
    """Owns the virtual-mic node and the PTT feed path."""

    def __init__(self, enabled: bool = True) -> None:
        self.enabled = enabled
        self.active = False  # a PTT feed session is open
        self._feeder: asyncio.subprocess.Process | None = None
        self._node_created = False  # we created the node (vs. pre-existing)

    async def start(self) -> bool:
        """Open a feed session (virtual mic node up + pw-cat feeder linked)."""
        if not self.enabled:
            log.warning("mic: voice.start mode=mic but mic is disabled in config")
            return False
        if self.active:
            return True
        try:
            if not await self._ensure_node():
                return False
            self._feeder = await asyncio.create_subprocess_exec(
                *FEEDER_ARGV,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            if not await self._link_feeder():
                log.warning("mic: could not link feeder into %r", NODE_DESC)
                await self._stop_feeder()
                return False
        except OSError as exc:
            log.warning("mic: cannot start virtual microphone: %s", exc)
            self._feeder = None
            return False
        self.active = True
        log.info("mic: feeding %r", NODE_DESC)
        return True

    def feed(self, data: bytes) -> None:
        """Forward one AUDIO frame into the virtual mic (best-effort)."""
        feeder = self._feeder
        if not self.active or feeder is None or feeder.stdin is None:
            return
        try:
            feeder.stdin.write(_apply_gain(data))
        except (BrokenPipeError, ConnectionResetError) as exc:
            log.warning("mic: feeder pipe broken (%s); will respawn on next PTT", exc)
            self._feeder = None
            self.active = False

    async def stop(self) -> None:
        """End the feed session (the virtual source stays registered)."""
        self.active = False
        await self._stop_feeder()

    async def close(self) -> None:
        """Full shutdown: stop feeding and remove the node we created."""
        await self.stop()
        if self._node_created:
            node_id = await _find_node_id()
            if node_id is not None:
                await _run("pw-cli", "destroy", str(node_id))
            self._node_created = False

    # -- internals -------------------------------------------------------------

    async def warmup(self) -> bool:
        """Register the virtual source without starting a feed session, so
        apps can list/bind \"Vibe Mic\" before the first PTT."""
        if not self.enabled:
            return False
        return await self._ensure_node()

    async def _ensure_node(self) -> bool:
        # Run migration even when the current source is already registered.
        # PipeWire adapter objects linger across daemon restarts.
        await _remove_legacy_nodes()
        if await _find_node_id() is not None:
            return True
        rc, _ = await _run(*CREATE_ARGV)
        if rc != 0:
            log.warning("mic: pw-cli create-node failed (rc=%s)", rc)
            return False
        self._node_created = True
        for _ in range(20):  # wait for registration
            if await _find_node_id() is not None:
                return True
            await asyncio.sleep(0.1)
        log.warning("mic: node %r did not register", NODE_NAME)
        return False

    async def _stop_feeder(self) -> None:
        feeder, self._feeder = self._feeder, None
        if feeder is not None:
            await _terminate(feeder)

    async def _link_feeder(self) -> bool:
        """Wire the feeder's output ports into the mic node's input ports."""
        deadline = asyncio.get_running_loop().time() + LINK_TIMEOUT_SEC
        while True:
            outs = await _list_output_ports()
            ports = [p for p in outs if p.startswith(f"{FEED_STREAM}:")]
            if ports:
                ok = True
                if f"{FEED_STREAM}:output_MONO" in ports:
                    for inp in ("input_FL", "input_FR"):
                        ok &= await _link(f"{FEED_STREAM}:output_MONO", f"{NODE_NAME}:{inp}")
                else:
                    for chan, inp in (("output_FL", "input_FL"), ("output_FR", "input_FR")):
                        ok &= await _link(f"{FEED_STREAM}:{chan}", f"{NODE_NAME}:{inp}")
                if ok:
                    return True
            if asyncio.get_running_loop().time() > deadline:
                return False
            await asyncio.sleep(0.1)


# -- process / graph helpers ----------------------------------------------------


async def _run(*argv: str) -> tuple[int, str]:
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=STOP_TIMEOUT_SEC)
        return proc.returncode or 0, out.decode(errors="replace")
    except (OSError, asyncio.TimeoutError) as exc:
        log.debug("mic: %s failed: %s", argv[0], exc)
        return 127, str(exc)


async def _run_capture(*argv: str) -> str:
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=STOP_TIMEOUT_SEC)
        return out.decode(errors="replace")
    except (OSError, asyncio.TimeoutError) as exc:
        log.debug("mic: %s capture failed: %s", argv[0], exc)
        return ""


async def _find_node_id(node_name: str = NODE_NAME) -> int | None:
    """The requested virtual-mic node's object id, or None if absent."""
    try:
        data = json.loads(await _run_capture("pw-dump"))
    except (json.JSONDecodeError, OSError):
        return None
    for obj in data:
        props = ((obj.get("info") or {}).get("props") or {})
        if props.get("node.name") == node_name:
            return obj.get("id")
    return None


async def _remove_legacy_nodes() -> None:
    """Remove virtual sources from older VibeStick releases, if any."""
    for node_name in LEGACY_NODE_NAMES:
        node_id = await _find_node_id(node_name)
        if node_id is not None:
            rc, _ = await _run("pw-cli", "destroy", str(node_id))
            if rc == 0:
                log.info("mic: removed obsolete virtual source %r", node_name)


async def _list_output_ports() -> list[str]:
    out = await _run_capture("pw-link", "-o")
    return [line.strip() for line in out.splitlines() if ":" in line]


async def _link(out_port: str, in_port: str) -> bool:
    rc, _ = await _run("pw-link", out_port, in_port)
    return rc == 0


async def _terminate(proc: asyncio.subprocess.Process) -> None:
    if proc.returncode is not None:
        return
    try:
        proc.terminate()
        await asyncio.wait_for(proc.wait(), timeout=STOP_TIMEOUT_SEC)
    except (ProcessLookupError, asyncio.TimeoutError):
        try:
            proc.kill()
        except ProcessLookupError:
            pass
