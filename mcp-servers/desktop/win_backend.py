"""Windows backend for the FRIDAY desktop MCP server (screen_look/click/type/key/scroll).

Same five tools, schemas, limits and error style as the Linux server (server.py + portal.py).
Capture uses mss + Pillow, input uses ctypes SendInput. Every ctypes/Windows/mss import is lazy,
so this module imports (and its pure parts are testable) on any OS.

Safety rails:
- Consent: ~/.friday/setup.json must have computerControl.consented == true.
- Control indicator: ~/.friday/run/control.json {active, since, action} while acting.
- Stop: if ~/.friday/run/stop exists the current action aborts, the flag is removed.
- Elevated or secure-desktop (UAC) targets are refused with a clear message.
"""

from __future__ import annotations

import io
import json
import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

MAX_TYPE = 2000
SETTLE_S = 0.45  # let the screen redraw before looking again


class WinControlError(RuntimeError):
    """User-facing failure (mirrors PortalError on Linux)."""


class StopRequested(Exception):
    """The stop flag was found; the current action must abort."""


# ---------------------------------------------------------------------------------------------
# Key combo parser (pure)
# ---------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Key:
    vk: int
    extended: bool = False


_EXT = True
KEYS: dict[str, Key] = {
    "return": Key(0x0D), "enter": Key(0x0D), "tab": Key(0x09), "escape": Key(0x1B),
    "esc": Key(0x1B), "backspace": Key(0x08), "delete": Key(0x2E, _EXT), "del": Key(0x2E, _EXT),
    "insert": Key(0x2D, _EXT), "space": Key(0x20),
    "up": Key(0x26, _EXT), "down": Key(0x28, _EXT), "left": Key(0x25, _EXT),
    "right": Key(0x27, _EXT), "home": Key(0x24, _EXT), "end": Key(0x23, _EXT),
    "pageup": Key(0x21, _EXT), "pagedown": Key(0x22, _EXT),
    "ctrl": Key(0xA2), "control": Key(0xA2), "shift": Key(0xA0), "alt": Key(0xA4),
    "super": Key(0x5B, _EXT), "meta": Key(0x5B, _EXT), "win": Key(0x5B, _EXT),
    "printscreen": Key(0x2C, _EXT),
    **{f"f{i}": Key(0x70 + i - 1) for i in range(1, 13)},
}
# US-layout punctuation -> (vk, needs_shift). Used for single-character keys in combos.
_PUNCT: dict[str, int] = {
    ";": 0xBA, "=": 0xBB, ",": 0xBC, "-": 0xBD, ".": 0xBE, "/": 0xBF, "`": 0xC0,
    "[": 0xDB, "\\": 0xDC, "]": 0xDD, "'": 0xDE,
}


def char_key(ch: str) -> Key:
    if "a" <= ch <= "z":
        return Key(0x41 + ord(ch) - ord("a"))
    if "0" <= ch <= "9":
        return Key(0x30 + ord(ch) - ord("0"))
    if ch in _PUNCT:
        return Key(_PUNCT[ch])
    raise WinControlError(f"Unknown key: {ch}")


def parse_combo(combo: str) -> list[Key]:
    """'ctrl+shift+t' -> keys, in the order given (modifiers first)."""
    out: list[Key] = []
    for part in [p.strip() for p in combo.replace(" ", "").split("+") if p.strip()]:
        low = part.lower()
        if low in KEYS:
            out.append(KEYS[low])
        elif len(part) == 1:
            out.append(char_key(low))
        else:
            raise WinControlError(f"Unknown key: {part}")
    if not out:
        raise WinControlError("No key given")
    return out


# ---------------------------------------------------------------------------------------------
# Coordinate mapping and scaling (pure)
# ---------------------------------------------------------------------------------------------


def scaled_size(full_w: int, full_h: int, max_width: int = 1280) -> tuple[int, int]:
    """Size screen_look shows: width clamped to [480, full_w], aspect kept."""
    width = max(480, min(int(max_width), full_w))
    if full_w > width:
        return width, round(full_h * width / full_w)
    return full_w, full_h


def view_to_virtual(x: float, y: float, view: dict, origin: tuple[int, int]) -> tuple[float, float]:
    """A point in the last screenshot -> virtual-screen pixel coordinates (may be negative)."""
    if not view:
        raise WinControlError("Look at the screen first (screen_look), then use coordinates from that image.")
    if not (0 <= x <= view["w"] and 0 <= y <= view["h"]):
        raise WinControlError(f"({x}, {y}) is outside the last screenshot ({view['w']}x{view['h']}).")
    return origin[0] + x * view["full_w"] / view["w"], origin[1] + y * view["full_h"] / view["h"]


def virtual_to_absolute(vx: float, vy: float, vscreen: tuple[int, int, int, int]) -> tuple[int, int]:
    """Virtual-screen pixels -> SendInput absolute coords (0..65535 over the virtual desktop)."""
    left, top, w, h = vscreen
    nx = round((vx - left) * 65535 / max(w - 1, 1))
    ny = round((vy - top) * 65535 / max(h - 1, 1))
    return max(0, min(65535, nx)), max(0, min(65535, ny))


# ---------------------------------------------------------------------------------------------
# Consent / control indicator / stop flag (pure file logic)
# ---------------------------------------------------------------------------------------------


def friday_home() -> Path:
    return Path(os.environ.get("FRIDAY_HOME") or (Path.home() / ".friday"))


class ControlFiles:
    def __init__(self, home: Path | None = None, clock: Callable[[], float] = time.time) -> None:
        self.home = Path(home) if home else friday_home()
        self.run = self.home / "run"
        self.clock = clock

    @property
    def setup_file(self) -> Path:
        return self.home / "setup.json"

    @property
    def control_file(self) -> Path:
        return self.run / "control.json"

    @property
    def stop_file(self) -> Path:
        return self.run / "stop"

    def consented(self) -> bool:
        try:
            data = json.loads(self.setup_file.read_text(encoding="utf-8-sig"))
            return data["computerControl"]["consented"] is True
        except (OSError, ValueError, KeyError, TypeError):
            return False

    def require_consent(self) -> None:
        if not self.consented():
            raise WinControlError(
                "Computer control isn't enabled. Sir hasn't consented yet: run FRIDAY setup (or set "
                f"computerControl.consented to true in {self.setup_file}) and try again."
            )

    def set_active(self, action: str) -> None:
        self._write_control({"active": True, "since": self._iso(), "action": action})

    def clear_active(self) -> None:
        try:
            self._write_control({"active": False, "since": self._iso(), "action": ""})
        except OSError:
            pass

    def stop_requested(self) -> bool:
        return self.stop_file.exists()

    def consume_stop(self) -> None:
        try:
            self.stop_file.unlink()
        except FileNotFoundError:
            pass

    def _iso(self) -> str:
        return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(self.clock())) + "Z"

    def _write_control(self, obj: dict) -> None:
        self.run.mkdir(parents=True, exist_ok=True)
        tmp = self.control_file.with_name(f"control.json.{os.getpid()}.tmp")
        tmp.write_text(json.dumps(obj), encoding="utf-8")
        os.replace(tmp, self.control_file)


# ---------------------------------------------------------------------------------------------
# Real Windows API (lazy ctypes). Tests substitute a fake with the same methods.
# ---------------------------------------------------------------------------------------------


class WinApi:
    """Thin wrapper over user32/kernel32/advapi32 + mss. Only constructed on Windows."""

    INPUT_MOUSE, INPUT_KEYBOARD = 0, 1
    MOUSEEVENTF_MOVE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_VIRTUALDESK = 0x1, 0x8000, 0x4000
    MOUSEEVENTF_WHEEL = 0x0800
    BUTTON_FLAGS = {"left": (0x2, 0x4), "right": (0x8, 0x10), "middle": (0x20, 0x40)}
    KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE = 0x1, 0x2, 0x4

    def __init__(self) -> None:
        import ctypes
        from ctypes import wintypes

        self.ct, self.wt = ctypes, wintypes
        self.user32 = ctypes.WinDLL("user32", use_last_error=True)
        self.kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self.advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
        self._define_structs()
        self._declare()
        self.set_dpi_aware()

    # -- setup ----------------------------------------------------------------------------
    def _define_structs(self) -> None:
        ct, wt = self.ct, self.wt

        class MOUSEINPUT(ct.Structure):
            _fields_ = [("dx", wt.LONG), ("dy", wt.LONG), ("mouseData", wt.DWORD),
                        ("dwFlags", wt.DWORD), ("time", wt.DWORD), ("dwExtraInfo", ct.c_size_t)]

        class KEYBDINPUT(ct.Structure):
            _fields_ = [("wVk", wt.WORD), ("wScan", wt.WORD), ("dwFlags", wt.DWORD),
                        ("time", wt.DWORD), ("dwExtraInfo", ct.c_size_t)]

        class HARDWAREINPUT(ct.Structure):
            _fields_ = [("uMsg", wt.DWORD), ("wParamL", wt.WORD), ("wParamH", wt.WORD)]

        class _U(ct.Union):
            _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]

        class INPUT(ct.Structure):
            _anonymous_ = ("u",)
            _fields_ = [("type", wt.DWORD), ("u", _U)]

        self.MOUSEINPUT, self.KEYBDINPUT, self.INPUT = MOUSEINPUT, KEYBDINPUT, INPUT

    def _declare(self) -> None:
        ct, wt = self.ct, self.wt
        u, k, a = self.user32, self.kernel32, self.advapi32
        u.SendInput.argtypes = [wt.UINT, ct.POINTER(self.INPUT), ct.c_int]
        u.SendInput.restype = wt.UINT
        u.GetForegroundWindow.restype = wt.HWND
        u.WindowFromPoint.argtypes = [wt.POINT]
        u.WindowFromPoint.restype = wt.HWND
        u.GetAncestor.argtypes = [wt.HWND, wt.UINT]
        u.GetAncestor.restype = wt.HWND
        u.GetWindowThreadProcessId.argtypes = [wt.HWND, ct.POINTER(wt.DWORD)]
        u.GetWindowThreadProcessId.restype = wt.DWORD
        u.OpenInputDesktop.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
        u.OpenInputDesktop.restype = wt.HANDLE
        u.CloseDesktop.argtypes = [wt.HANDLE]
        u.MapVirtualKeyW.argtypes = [wt.UINT, wt.UINT]
        u.MapVirtualKeyW.restype = wt.UINT
        u.GetSystemMetrics.argtypes = [ct.c_int]
        k.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
        k.OpenProcess.restype = wt.HANDLE
        k.CloseHandle.argtypes = [wt.HANDLE]
        k.GetCurrentProcess.restype = wt.HANDLE
        a.OpenProcessToken.argtypes = [wt.HANDLE, wt.DWORD, ct.POINTER(wt.HANDLE)]
        a.GetTokenInformation.argtypes = [wt.HANDLE, ct.c_int, ct.c_void_p, wt.DWORD, ct.POINTER(wt.DWORD)]

    def set_dpi_aware(self) -> None:
        """Per-monitor v2 so mss and SendInput agree on physical pixels."""
        ct = self.ct
        try:
            if self.user32.SetProcessDpiAwarenessContext(ct.c_void_p(-4)):  # PER_MONITOR_AWARE_V2
                return
        except (AttributeError, OSError):
            pass
        try:
            ct.windll.shcore.SetProcessDpiAwareness(2)
        except (AttributeError, OSError):
            try:
                self.user32.SetProcessDPIAware()
            except (AttributeError, OSError):
                pass

    # -- screen ---------------------------------------------------------------------------
    def virtual_screen(self) -> tuple[int, int, int, int]:
        g = self.user32.GetSystemMetrics
        return g(76), g(77), g(78), g(79)  # SM_X/Y/CXVIRTUALSCREEN

    def grab(self):
        """Whole virtual desktop (all monitors) as an RGB PIL image + its (left, top)."""
        import mss
        from PIL import Image

        with mss.mss() as sct:
            mon = sct.monitors[0]
            shot = sct.grab(mon)
            img = Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")
            return img, (mon["left"], mon["top"])

    # -- elevation / secure desktop -------------------------------------------------------
    def _pid_of(self, hwnd) -> int:
        pid = self.wt.DWORD(0)
        self.user32.GetWindowThreadProcessId(hwnd, self.ct.byref(pid))
        return pid.value

    def _is_elevated_pid(self, pid: int) -> bool:
        """True if the process is elevated, or can't be inspected (access denied)."""
        ct, wt = self.ct, self.wt
        h = self.kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return True
        tok = wt.HANDLE()
        try:
            if not self.advapi32.OpenProcessToken(h, 0x8, ct.byref(tok)):  # TOKEN_QUERY
                return True
            elev, size = wt.DWORD(0), wt.DWORD(0)
            ok = self.advapi32.GetTokenInformation(tok, 20, ct.byref(elev), ct.sizeof(elev), ct.byref(size))
            return True if not ok else bool(elev.value)  # TokenElevation
        finally:
            if tok:
                self.kernel32.CloseHandle(tok)
            self.kernel32.CloseHandle(h)

    def _self_elevated(self) -> bool:
        return self._is_elevated_pid(os.getpid())

    def blocked_reason(self, point: tuple[float, float] | None = None) -> str | None:
        """Why input can't go to the target, or None if it can."""
        ct, wt = self.ct, self.wt
        desk = self.user32.OpenInputDesktop(0, False, 0x100)  # DESKTOP_SWITCHDESKTOP
        if not desk:
            return ("The secure desktop is showing (UAC prompt or lock screen). Windows doesn't let "
                    "FRIDAY act there: Sir needs to handle it himself.")
        self.user32.CloseDesktop(desk)
        if self._self_elevated():
            return None  # an elevated FRIDAY may drive elevated windows
        hwnds = [self.user32.GetForegroundWindow()]
        if point is not None:
            pt = wt.POINT(int(point[0]), int(point[1]))
            top = self.user32.GetAncestor(self.user32.WindowFromPoint(pt), 2)  # GA_ROOT
            hwnds.append(top)
        for hwnd in hwnds:
            if hwnd and self._is_elevated_pid(self._pid_of(hwnd)):
                return ("That window is running as administrator (elevated), and FRIDAY isn't, so "
                        "Windows blocks its input. Sir needs to use that window himself, or restart "
                        "FRIDAY as administrator.")
        return None

    # -- input ----------------------------------------------------------------------------
    def _send(self, *inputs) -> None:
        arr = (self.INPUT * len(inputs))(*inputs)
        sent = self.user32.SendInput(len(inputs), arr, self.ct.sizeof(self.INPUT))
        if sent != len(inputs):
            raise WinControlError(
                f"Windows rejected the input (SendInput {sent}/{len(inputs)}, error {self.ct.get_last_error()}). "
                "The target may be elevated or protected."
            )

    def _mouse(self, flags: int, dx: int = 0, dy: int = 0, data: int = 0):
        i = self.INPUT(type=self.INPUT_MOUSE)
        i.mi = self.MOUSEINPUT(dx, dy, data & 0xFFFFFFFF, flags, 0, 0)
        return i

    def move_abs(self, ax: int, ay: int) -> None:
        f = self.MOUSEEVENTF_MOVE | self.MOUSEEVENTF_ABSOLUTE | self.MOUSEEVENTF_VIRTUALDESK
        self._send(self._mouse(f, ax, ay))

    def button(self, name: str, down: bool) -> None:
        if name not in self.BUTTON_FLAGS:
            raise WinControlError(f"Unknown button: {name} (use left, right or middle).")
        self._send(self._mouse(self.BUTTON_FLAGS[name][0 if down else 1]))

    def wheel(self, delta: int) -> None:
        self._send(self._mouse(self.MOUSEEVENTF_WHEEL, data=delta))

    def key(self, key: Key, down: bool) -> None:
        scan = self.user32.MapVirtualKeyW(key.vk, 0)
        flags = (self.KEYEVENTF_EXTENDEDKEY if key.extended else 0) | (0 if down else self.KEYEVENTF_KEYUP)
        i = self.INPUT(type=self.INPUT_KEYBOARD)
        i.ki = self.KEYBDINPUT(key.vk, scan, flags, 0, 0)
        self._send(i)

    def unicode_unit(self, unit: int, down: bool) -> None:
        flags = self.KEYEVENTF_UNICODE | (0 if down else self.KEYEVENTF_KEYUP)
        i = self.INPUT(type=self.INPUT_KEYBOARD)
        i.ki = self.KEYBDINPUT(0, unit, flags, 0, 0)
        self._send(i)


# ---------------------------------------------------------------------------------------------
# Controller: the five tools' behaviour, against an injectable API
# ---------------------------------------------------------------------------------------------


class Controller:
    def __init__(self, api=None, files: ControlFiles | None = None,
                 sleep: Callable[[float], None] = time.sleep) -> None:
        self._api = api
        self.files = files or ControlFiles()
        self.sleep = sleep
        self.view: dict[str, int] = {}
        self.origin: tuple[int, int] = (0, 0)

    @property
    def api(self):
        if self._api is None:
            if not sys.platform.startswith("win"):
                raise WinControlError("The Windows backend only runs on Windows.")
            self._api = WinApi()
        return self._api

    # -- guards ---------------------------------------------------------------------------
    def check_stop(self) -> None:
        if self.files.stop_requested():
            raise StopRequested()

    def run_action(self, action: str, fn: Callable[[], object], guard_point=None):
        """Consent + stop + indicator + elevation wrapper. Returns fn() or a stopped message."""
        self.files.require_consent()
        if self.files.stop_requested():
            self.files.consume_stop()
            return "Stopped: Sir pressed stop. Nothing was done."
        self.files.set_active(action)
        try:
            reason = self.api.blocked_reason(guard_point() if callable(guard_point) else guard_point)
            if reason:
                raise WinControlError(reason)
            return fn()
        except StopRequested:
            self.files.consume_stop()
            return f"Stopped: Sir pressed stop, so I aborted '{action}'."
        finally:
            self.files.clear_active()

    # -- tools ----------------------------------------------------------------------------
    def look(self, max_width: int = 1280) -> tuple[bytes, str]:
        from PIL import Image as PILImage

        im, origin = self.api.grab()
        im = im.convert("RGB")
        full_w, full_h = im.size
        w, h = scaled_size(full_w, full_h, max_width)
        if (w, h) != (full_w, full_h):
            im = im.resize((w, h), PILImage.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=82)
        self.origin = (int(origin[0]), int(origin[1]))
        self.view.update(w=w, h=h, full_w=full_w, full_h=full_h)
        note = f"Screen {full_w}x{full_h}, shown at {w}x{h}. Give coordinates in this image's pixels."
        return buf.getvalue(), note

    def _to_virtual(self, x: float, y: float) -> tuple[float, float]:
        return view_to_virtual(x, y, self.view, self.origin)

    def _move(self, vx: float, vy: float) -> None:
        ax, ay = virtual_to_absolute(vx, vy, self.api.virtual_screen())
        self.api.move_abs(ax, ay)

    def click(self, x: float, y: float, button: str = "left", double: bool = False) -> str:
        vx, vy = self._to_virtual(x, y)

        def go():
            self._move(vx, vy)
            self.sleep(0.05)
            for _ in range(2 if double else 1):
                self.check_stop()
                self.api.button(button, True)
                self.sleep(0.03)
                self.api.button(button, False)
                self.sleep(0.06)
            return f"{'Double-clicked' if double else 'Clicked'} {button} at ({x:.0f}, {y:.0f})."

        return self.run_action("click", go, (vx, vy))

    def type_text(self, text: str) -> str:
        if len(text) > MAX_TYPE:
            raise WinControlError(f"That's {len(text)} characters; type at most {MAX_TYPE} at a time.")

        def go():
            for ch in text:
                self.check_stop()
                if ch in "\r\n":
                    if ch == "\r":
                        continue
                    self._tap(KEYS["return"])
                elif ch == "\t":
                    self._tap(KEYS["tab"])
                else:
                    data = ch.encode("utf-16-le")
                    for i in range(0, len(data), 2):  # surrogate pairs go as two units
                        unit = int.from_bytes(data[i:i + 2], "little")
                        self.api.unicode_unit(unit, True)
                        self.api.unicode_unit(unit, False)
                self.sleep(0.008)
            return f"Typed {len(text)} characters."

        return self.run_action("type", go)

    def _tap(self, key: Key) -> None:
        self.api.key(key, True)
        self.api.key(key, False)

    def press(self, keys: str) -> str:
        combo = parse_combo(keys)

        def guarded():
            pressed: list[Key] = []
            try:
                for k in combo:
                    self.check_stop()
                    self.api.key(k, True)
                    pressed.append(k)
                    self.sleep(0.02)
            except BaseException:
                for k in reversed(pressed):
                    self.api.key(k, False)
                raise
            for k in reversed(combo):
                self.api.key(k, False)
                self.sleep(0.02)
            return f"Pressed {keys}."

        return self.run_action("key", guarded)

    def scroll(self, x: float, y: float, direction: str = "down", amount: int = 3) -> str:
        steps = max(1, min(int(amount), 15)) * (1 if direction.lower() != "up" else -1)
        vx, vy = self._to_virtual(x, y)

        def go():
            self._move(vx, vy)
            self.sleep(0.05)
            self.check_stop()
            self.api.wheel(-steps * 120)  # WHEEL_DELTA 120; positive = away from the user (up)
            return f"Scrolled {direction} {abs(steps)} at ({x:.0f}, {y:.0f})."

        return self.run_action("scroll", go, (vx, vy))


# ---------------------------------------------------------------------------------------------
# MCP server (same tools/schemas/docstrings as server.py)
# ---------------------------------------------------------------------------------------------


def make_server(controller: Controller | None = None):
    import functools

    from mcp.server.mcpserver import MCPServer
    from mcp.server.mcpserver.exceptions import ToolError
    from mcp.server.mcpserver.utilities.types import Image

    ctl = controller or Controller()
    server = MCPServer("desktop")

    def tool(fn):
        @functools.wraps(fn)
        def wrapped(*args, **kwargs):
            try:
                return fn(*args, **kwargs)
            except ToolError:
                raise
            except Exception as e:
                raise ToolError(str(e)) from e

        return server.tool()(wrapped)

    def result(note: str, look_after: bool):
        if not look_after or note.startswith("Stopped"):
            return note
        time.sleep(SETTLE_S)
        data, view = ctl.look()
        return [Image(data=data, format="jpeg"), f"{note} Now: {view}"]

    @tool
    def screen_look(max_width: int = 1280):
        """See Sir's screen right now (a screenshot). Use it to answer questions about what's on
        screen, and always before clicking: coordinates for the other screen_* tools are pixels in
        the most recent screenshot. Never read out passwords or private details you happen to see."""
        data, note = ctl.look(max_width)
        return [Image(data=data, format="jpeg"), note]

    @tool
    def screen_click(x: float, y: float, button: str = "left", double: bool = False, look_after: bool = True):
        """Click at (x, y) in the last screenshot's pixels. button: left, right or middle.
        Before clicking anything that sends, submits, pays, buys, deletes or posts, stop and ask Sir."""
        return result(ctl.click(x, y, button, double), look_after)

    @tool
    def screen_type(text: str, look_after: bool = False):
        """Type text into whatever has keyboard focus (click the field first). Never type
        passwords, card numbers or other secrets: ask Sir to type those himself."""
        return result(ctl.type_text(text), look_after)

    @tool
    def screen_key(keys: str, look_after: bool = True):
        """Press a key or shortcut, e.g. "Return", "Escape", "ctrl+l", "ctrl+shift+t", "alt+tab",
        "super" (opens the Start menu). Keys in a combo are joined with +."""
        return result(ctl.press(keys), look_after)

    @tool
    def screen_scroll(x: float, y: float, direction: str = "down", amount: int = 3, look_after: bool = True):
        """Scroll at (x, y) in the last screenshot's pixels. direction: up or down; amount: notches (1-15)."""
        return result(ctl.scroll(x, y, direction, amount), look_after)

    return server


def check() -> None:
    data, note = Controller().look()
    print(note, f"{len(data) // 1024} KB")
