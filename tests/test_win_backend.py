"""Pure-logic tests for mcp-servers/desktop/win_backend.py (runs on any OS)."""
import io
import json
import sys
import types
from pathlib import Path

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "mcp-servers" / "desktop"))
import win_backend as wb  # noqa: E402


class FakeApi:
    def __init__(self, blocked=None, size=(2560, 1440), origin=(0, 0), on_event=None):
        self.events, self.blocked, self.size, self.origin = [], blocked, size, origin
        self.on_event = on_event
        self.vs = (origin[0], origin[1], size[0], size[1])

    def _rec(self, *e):
        self.events.append(e)
        if self.on_event:
            self.on_event(e)

    def blocked_reason(self, point=None):
        self._rec("guard", point)
        return self.blocked

    def virtual_screen(self):
        return self.vs

    def grab(self):
        return Image.new("RGB", self.size, (10, 20, 30)), self.origin

    def move_abs(self, x, y): self._rec("move", x, y)
    def button(self, n, d): self._rec("button", n, d)
    def wheel(self, d): self._rec("wheel", d)
    def key(self, k, d): self._rec("key", k.vk, d)
    def unicode_unit(self, u, d): self._rec("uni", u, d)


@pytest.fixture
def home(tmp_path):
    (tmp_path / "setup.json").write_text(json.dumps({"computerControl": {"consented": True}}))
    return tmp_path


def make(home, **kw):
    api = FakeApi(**kw)
    ctl = wb.Controller(api=api, files=wb.ControlFiles(home), sleep=lambda s: None)
    return ctl, api


# --- combo parser -------------------------------------------------------------------------
def test_combo_basic():
    assert [k.vk for k in wb.parse_combo("ctrl+shift+t")] == [0xA2, 0xA0, 0x54]
    assert wb.parse_combo("Return")[0].vk == 0x0D
    assert wb.parse_combo(" alt + Tab ")[1].vk == 0x09
    assert wb.parse_combo("f5")[0].vk == 0x74
    assert wb.parse_combo("ctrl+/")[1].vk == 0xBF


def test_combo_super_is_windows_key_extended():
    for name in ("super", "win", "meta"):
        k = wb.parse_combo(name)[0]
        assert k.vk == 0x5B and k.extended


def test_combo_errors():
    with pytest.raises(wb.WinControlError, match="Unknown key: bogus"):
        wb.parse_combo("ctrl+bogus")
    with pytest.raises(wb.WinControlError, match="No key given"):
        wb.parse_combo(" + ")


# --- scaling / mapping ----------------------------------------------------------------------
def test_scaled_size():
    assert wb.scaled_size(2560, 1440) == (1280, 720)
    assert wb.scaled_size(1000, 500, 5000) == (1000, 500)
    assert wb.scaled_size(2560, 1440, 100) == (480, 270)


def test_view_to_virtual_scales_and_offsets():
    view = {"w": 1280, "h": 720, "full_w": 2560, "full_h": 1440}
    assert wb.view_to_virtual(640, 360, view, (0, 0)) == (1280, 720)
    # secondary monitor to the left: negative origin
    assert wb.view_to_virtual(0, 0, view, (-1920, -100)) == (-1920, -100)


def test_view_to_virtual_errors():
    with pytest.raises(wb.WinControlError, match="Look at the screen first"):
        wb.view_to_virtual(1, 1, {}, (0, 0))
    view = {"w": 100, "h": 50, "full_w": 100, "full_h": 50}
    with pytest.raises(wb.WinControlError, match="outside the last screenshot"):
        wb.view_to_virtual(101, 1, view, (0, 0))


def test_virtual_to_absolute():
    vs = (-1920, 0, 4480, 1080)
    assert wb.virtual_to_absolute(-1920, 0, vs) == (0, 0)
    assert wb.virtual_to_absolute(-1920 + 4479, 1079, vs) == (65535, 65535)
    assert wb.virtual_to_absolute(99999, -5, vs) == (65535, 0)


# --- consent / control / stop files ---------------------------------------------------------
def test_consent(tmp_path):
    f = wb.ControlFiles(tmp_path)
    assert not f.consented()
    (tmp_path / "setup.json").write_text("{not json")
    assert not f.consented()
    (tmp_path / "setup.json").write_text(json.dumps({"computerControl": {"consented": "yes"}}))
    assert not f.consented()
    (tmp_path / "setup.json").write_text('\ufeff{"computerControl": {"consented": true}}')
    assert f.consented()


def test_no_consent_blocks_and_does_nothing(tmp_path):
    ctl, api = make(tmp_path)
    ctl.view.update(w=10, h=10, full_w=10, full_h=10)
    with pytest.raises(wb.WinControlError, match="consent"):
        ctl.click(1, 1)
    assert api.events == []
    assert not (tmp_path / "run" / "control.json").exists()


def test_control_json_written_during_and_cleared_after(home):
    seen = []
    ctl, api = make(home, on_event=lambda e: seen.append(
        json.loads((home / "run" / "control.json").read_text())) if e[0] == "move" else None)
    ctl.look()
    assert ctl.click(640, 360) == "Clicked left at (640, 360)."
    assert seen[0]["active"] is True and seen[0]["action"] == "click" and seen[0]["since"]
    assert json.loads((home / "run" / "control.json").read_text())["active"] is False


def test_stop_before_action(home):
    ctl, api = make(home)
    (home / "run").mkdir()
    (home / "run" / "stop").write_text("")
    msg = ctl.type_text("hi")
    assert msg.startswith("Stopped")
    assert not (home / "run" / "stop").exists()
    assert api.events == []


def test_stop_mid_typing_aborts_and_clears(home):
    def trip(e):
        if e == ("uni", ord("b"), False):
            (home / "run" / "stop").write_text("")
    ctl, api = make(home, on_event=trip)
    (home / "run").mkdir()
    msg = ctl.type_text("abcdef")
    assert msg.startswith("Stopped")
    assert ("uni", ord("c"), True) not in api.events
    assert not (home / "run" / "stop").exists()
    assert json.loads((home / "run" / "control.json").read_text())["active"] is False


def test_stop_mid_key_releases_pressed_keys(home):
    def trip(e):
        if e == ("key", 0xA2, True):
            (home / "run" / "stop").write_text("")
    ctl, api = make(home, on_event=trip)
    (home / "run").mkdir()
    assert ctl.press("ctrl+c").startswith("Stopped")
    assert ("key", 0xA2, False) in api.events
    assert ("key", 0x43, True) not in api.events


# --- backend dispatch with fake API ---------------------------------------------------------
def test_look_sets_view_and_note(home):
    ctl, _ = make(home, origin=(-1920, 0))
    data, note = ctl.look()
    assert note == "Screen 2560x1440, shown at 1280x720. Give coordinates in this image's pixels."
    assert Image.open(io.BytesIO(data)).size == (1280, 720)
    assert ctl.origin == (-1920, 0)


def test_click_maps_to_absolute_and_buttons(home):
    ctl, api = make(home, size=(2560, 1440))
    ctl.look()
    ctl.click(640, 360, button="right", double=True)
    assert ("move", 32780, 32790) in api.events
    assert api.events.count(("button", "right", True)) == 2
    assert ("guard", (1280, 720)) in api.events


def test_click_requires_look(home):
    ctl, _ = make(home)
    with pytest.raises(wb.WinControlError, match="Look at the screen first"):
        ctl.click(1, 1)


def test_elevated_target_refused_with_nothing_sent(home):
    ctl, api = make(home, blocked="That window is running as administrator (elevated)")
    ctl.look()
    with pytest.raises(wb.WinControlError, match="administrator"):
        ctl.click(10, 10)
    with pytest.raises(wb.WinControlError, match="administrator"):
        ctl.press("enter")
    assert [e for e in api.events if e[0] != "guard"] == []
    assert json.loads((home / "run" / "control.json").read_text())["active"] is False


def test_type_unicode_enter_tab_and_limit(home):
    ctl, api = make(home)
    assert ctl.type_text("a\n\té😀") == "Typed 5 characters."
    uni = [e[1] for e in api.events if e[0] == "uni" and e[2]]
    assert uni == [ord("a"), ord("é"), 0xD83D, 0xDE00]
    assert ("key", 0x0D, True) in api.events and ("key", 0x09, True) in api.events
    with pytest.raises(wb.WinControlError, match="at most 2000"):
        ctl.type_text("x" * 2001)


def test_press_order(home):
    ctl, api = make(home)
    assert ctl.press("ctrl+shift+t") == "Pressed ctrl+shift+t."
    keys = [e for e in api.events if e[0] == "key"]
    assert keys == [("key", 0xA2, True), ("key", 0xA0, True), ("key", 0x54, True),
                    ("key", 0x54, False), ("key", 0xA0, False), ("key", 0xA2, False)]


def test_scroll_direction_and_clamp(home):
    ctl, api = make(home)
    ctl.look()
    assert ctl.scroll(10, 10, "down", 99) == "Scrolled down 15 at (10, 10)."
    assert ("wheel", -1800) in api.events
    ctl.scroll(10, 10, "up", 0)
    assert ("wheel", 120) in api.events


def test_grab_with_stubbed_mss(monkeypatch):
    class Shot:
        size = (2, 1)
        bgra = bytes([1, 2, 3, 255, 4, 5, 6, 255])

    class Sct:
        monitors = [{"left": -5, "top": 7, "width": 2, "height": 1}]
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def grab(self, mon): return Shot()

    monkeypatch.setitem(sys.modules, "mss", types.SimpleNamespace(mss=lambda: Sct()))
    img, origin = object.__new__(wb.WinApi).grab()
    assert origin == (-5, 7)
    assert img.getpixel((0, 0)) == (3, 2, 1)


def test_module_imports_without_windows():
    assert wb.MAX_TYPE == 2000 and wb.SETTLE_S == 0.45
    with pytest.raises(wb.WinControlError, match="only runs on Windows"):
        _ = wb.Controller(files=wb.ControlFiles(Path("/nonexistent"))).api
