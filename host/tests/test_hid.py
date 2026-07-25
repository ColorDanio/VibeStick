from vibestick.hid import HID_USAGE_F14, HID_USAGE_F15, KEY_F14, KEY_F15, VirtualKeyboard


class CaptureKeyboard(VirtualKeyboard):
    def __init__(self):
        super().__init__()
        self.events = []
        self._fd = 1

    def _emit(self, code, value):
        self.events.append((code, value))

    def _sync(self):
        self.events.append(("sync", 0))


def test_explicit_report_id_generates_f15_press_and_release():
    keyboard = CaptureKeyboard()
    keyboard.report(bytes([1, 0, 0, HID_USAGE_F15, 0, 0, 0, 0, 0]))
    keyboard.report(bytes([1, 0, 0, 0, 0, 0, 0, 0, 0]))
    assert keyboard.events == [(KEY_F15, 1), ("sync", 0), (KEY_F15, 0), ("sync", 0)]


def test_report_without_id_generates_f14():
    keyboard = CaptureKeyboard()
    keyboard.report(bytes([0, 0, HID_USAGE_F14, 0, 0, 0, 0, 0]))
    assert keyboard.events == [(KEY_F14, 1), ("sync", 0)]


def test_start_registers_keyboard_before_first_press():
    keyboard = CaptureKeyboard()
    assert keyboard.start() is True


def test_close_releases_pressed_keys(monkeypatch):
    keyboard = VirtualKeyboard()
    keyboard._fd = 42
    keyboard._pressed = {KEY_F14, KEY_F15}
    writes = []
    monkeypatch.setattr("vibestick.hid.os.write", lambda _fd, data: writes.append(data))
    monkeypatch.setattr("vibestick.hid.os.close", lambda _fd: None)
    monkeypatch.setattr("vibestick.hid.fcntl.ioctl", lambda *_args: None)
    keyboard.close()
    assert keyboard._fd is None
    assert keyboard._pressed == set()
    assert len(writes) == 3  # two releases + SYN_REPORT
