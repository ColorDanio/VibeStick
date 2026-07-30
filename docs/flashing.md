# Flashing Vibe Stick firmware

This guide applies to **M5StickC Plus** (`m5stick-c`) and **M5StickS3**
(`m5stick-s3`) on Linux, macOS and Windows 11. Use a USB cable that carries
data; many charging-only cables power the Stick but do not expose a serial
port.

## 1. Install PlatformIO

The easiest cross-platform option is the PlatformIO extension for Visual Studio
Code. Alternatively install the command-line tool with `pipx`:

```sh
pipx install platformio
pio --version
```

If `pipx` is unavailable, install it first with your system package manager or
use `python -m pip install --user platformio`; ensure the Python scripts
directory is on `PATH` before invoking `pio`.

Clone this repository, then connect the Stick directly to the computer over
USB. PlatformIO downloads the required ESP32 toolchain and libraries the first
time it builds.

## 2. Find the serial port

| System | Typical port | Find it |
| --- | --- | --- |
| Linux | `/dev/ttyUSB0`, `/dev/ttyACM0` | `ls /dev/ttyUSB* /dev/ttyACM*` |
| macOS | `/dev/cu.SLAB_USBtoUART`, `/dev/cu.usbserial-*`, `/dev/cu.usbmodem*` | `ls /dev/cu.*` |
| Windows 11 | `COM3`, `COM4`, … | **Device Manager → Ports (COM & LPT)** |

M5StickC Plus commonly exposes a Silicon Labs CP210x USB serial interface;
M5StickS3 may expose a native USB CDC interface. If no port appears, try a
known data cable and another USB port. On Windows, install the CP210x driver
when Device Manager shows an unknown device. On Linux, add your user to the
serial-access group if the port reports permission denied, then sign out and
back in:

```sh
sudo usermod -aG dialout "$USER"
```

## 3. Build and upload

Run these commands from the repository root. Replace the example port with the
one discovered above; omit `--upload-port` if PlatformIO detects it correctly.

### M5StickC Plus

```sh
pio run -d firmware -e m5stick-c -t upload --upload-port /dev/ttyUSB0
```

### M5StickS3

```sh
pio run -d firmware -e m5stick-s3 -t upload --upload-port /dev/ttyACM0
```

The commands are the same on macOS and Windows; only the port changes. For
example, in PowerShell use `--upload-port COM4`, and on macOS use a value such
as `--upload-port /dev/cu.usbserial-0001`.

The repository configures the M5StickS3 uploader to use the ESP32-S3 native
USB reset path. Do not add custom DTR/RTS reset flags: its normal USB CDC port
may briefly disappear when those legacy serial-control signals are used.

After `SUCCESS`, unplug and reconnect the Stick or restart it. Its serial log
should include the current Vibe Stick version and `advertising as 'VibeStick'`.

## Troubleshooting

- **No serial port:** use a data cable, remove other serial-monitor programs,
  and install the appropriate USB serial driver.
- **Port busy:** close PlatformIO Monitor, `screen`, `minicom`, or any other
  program that has the port open, then retry.
- **Upload cannot enter download mode:** disconnect/reconnect the Stick and
  retry once. If automatic reset repeatedly fails, use the board's documented
  ESP32 download/recovery procedure from M5Stack for your exact model.
- **Verify firmware logs:**

  ```sh
  pio device monitor -d firmware --port /dev/ttyUSB0 --baud 115200
  ```

  On macOS or Windows, substitute the matching serial port.

Flashing replaces the firmware on the Stick but does not remove its Bluetooth
pairing. If the desktop app cannot reconnect after an upgrade, use its
**Reconnect** action first; only remove and pair the `VibeStick` device again
if necessary.
