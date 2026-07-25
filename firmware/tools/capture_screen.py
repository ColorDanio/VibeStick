#!/usr/bin/env python3
"""Request a real RGB565 LCD screenshot from a flashed VibeStick."""
import argparse
import re
import time
from pathlib import Path

import serial
from PIL import Image


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", default="/dev/ttyUSB0")
    ap.add_argument("--out", default="/tmp/vibestick-previews/real-screen.png")
    args = ap.parse_args()
    with serial.Serial(args.port, 115200, timeout=0.2) as dev:
        dev.reset_input_buffer()
        dev.write(b"screenshot\n")
        deadline, data = time.monotonic() + 12, bytearray()
        while time.monotonic() < deadline:
            data.extend(dev.read(4096))
            match = re.search(rb"VIBESCREEN (\d+) (\d+) RGB565LE\n", data)
            if not match:
                continue
            w, h = map(int, match.groups())
            start, size = match.end(), w * h * 2
            if len(data) >= start + size:
                raw = data[start:start + size]
                rgb = bytearray()
                for i in range(0, len(raw), 2):
                    px = raw[i] | raw[i + 1] << 8
                    rgb.extend((((px >> 11) * 255 // 31),
                                ((px >> 5 & 63) * 255 // 63),
                                ((px & 31) * 255 // 31)))
                out = Path(args.out)
                out.parent.mkdir(parents=True, exist_ok=True)
                Image.frombytes("RGB", (w, h), bytes(rgb)).save(out)
                print(out)
                return
    raise SystemExit("no complete screenshot received")


if __name__ == "__main__":
    main()
