"""GNOME desktop portals for FRIDAY: screenshots, and pointer/keyboard input via Remote Desktop.

Wayland doesn't let ordinary apps read the screen or inject input; the portals do, with Sir's
consent. Screenshots use the Screenshot portal (permission remembered after the first time).
Input uses a Remote Desktop session: GNOME asks Sir once, then remembers it (restore token), and
shows its own top-bar indicator with a stop button whenever FRIDAY is in control.

All D-Bus work happens on one worker thread with its own GLib main context.
"""

from __future__ import annotations

import concurrent.futures
import itertools
import os
import shutil
import threading
import urllib.parse
from pathlib import Path

from gi.repository import Gio, GLib

STATE = Path.home() / ".friday" / "desktop"
TOKEN_FILE = STATE / "restore_token"
DESKTOP = "org.freedesktop.portal.Desktop"
PATH = "/org/freedesktop/portal/desktop"
REQUEST = "org.freedesktop.portal.Request"

# evdev button codes
BUTTONS = {"left": 0x110, "right": 0x111, "middle": 0x112}
# X keysyms for named keys
KEYSYMS = {
    "return": 0xFF0D, "enter": 0xFF0D, "tab": 0xFF09, "escape": 0xFF1B, "esc": 0xFF1B,
    "backspace": 0xFF08, "delete": 0xFFFF, "del": 0xFFFF, "insert": 0xFF63, "space": 0x20,
    "up": 0xFF52, "down": 0xFF54, "left": 0xFF51, "right": 0xFF53,
    "home": 0xFF50, "end": 0xFF57, "pageup": 0xFF55, "pagedown": 0xFF56,
    "ctrl": 0xFFE3, "control": 0xFFE3, "shift": 0xFFE1, "alt": 0xFFE9,
    "super": 0xFFEB, "meta": 0xFFEB, "win": 0xFFEB, "printscreen": 0xFF61,
    **{f"f{i}": 0xFFBE + i - 1 for i in range(1, 13)},
}


class PortalError(RuntimeError):
    pass


def char_keysym(ch: str) -> int:
    code = ord(ch)
    if ch == "\n":
        return KEYSYMS["return"]
    if ch == "\t":
        return KEYSYMS["tab"]
    if 0x20 <= code <= 0x7E or 0xA0 <= code <= 0xFF:
        return code
    return 0x01000000 + code


def parse_combo(combo: str) -> list[int]:
    """'ctrl+shift+t' -> keysyms, modifiers first."""
    out = []
    for part in [p.strip() for p in combo.replace(" ", "").split("+") if p.strip()]:
        low = part.lower()
        if low in KEYSYMS:
            out.append(KEYSYMS[low])
        elif len(part) == 1:
            out.append(char_keysym(part.lower()))
        else:
            raise PortalError(f"Unknown key: {part}")
    if not out:
        raise PortalError("No key given")
    return out


class Portal:
    def __init__(self) -> None:
        self._pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        self._ctx: GLib.MainContext | None = None
        self._bus: Gio.DBusConnection | None = None
        self._tokens = itertools.count(1)
        self.session: str | None = None
        self.stream: tuple[int, int, int, int, int] | None = None  # node, x, y, w, h
        self._lock = threading.Lock()

    # --- worker-thread plumbing ----------------------------------------------------------------
    def _run(self, fn, *args, timeout: float = 90):
        return self._pool.submit(self._in_ctx, fn, *args).result(timeout=timeout)

    def _in_ctx(self, fn, *args):
        if self._ctx is None:
            # Started as a plugin, the environment may not say where Sir's session bus is.
            if not os.environ.get("DBUS_SESSION_BUS_ADDRESS"):
                runtime = os.environ.get("XDG_RUNTIME_DIR") or f"/run/user/{os.getuid()}"
                os.environ["DBUS_SESSION_BUS_ADDRESS"] = f"unix:path={runtime}/bus"
            self._ctx = GLib.MainContext.new()
            self._ctx.push_thread_default()
            self._bus = Gio.bus_get_sync(Gio.BusType.SESSION)
        return fn(*args)

    def _request(self, iface: str, method: str, sig: str, values: list, timeout_s: int = 80) -> dict:
        """Call a portal method that answers with a Request.Response signal.

        `values` holds the method arguments; its last item is the options dict (str -> Variant).
        """
        token = f"friday{os.getpid()}_{next(self._tokens)}"
        sender = self._bus.get_unique_name()[1:].replace(".", "_")
        handle = f"/org/freedesktop/portal/desktop/request/{sender}/{token}"
        box: dict = {}

        def on_response(_c, _s, _p, _i, _sig, params):
            box["code"], box["results"] = params.unpack()

        sub = self._bus.signal_subscribe(DESKTOP, REQUEST, "Response", handle, None,
                                         Gio.DBusSignalFlags.NO_MATCH_RULE, on_response)
        try:
            opts = {**values[-1], "handle_token": GLib.Variant("s", token)}
            self._bus.call_sync(DESKTOP, PATH, iface, method, GLib.Variant(sig, (*values[:-1], opts)),
                                None, Gio.DBusCallFlags.NONE, -1, None)
            deadline = GLib.get_monotonic_time() + timeout_s * 1_000_000
            while "code" not in box and GLib.get_monotonic_time() < deadline:
                if not self._ctx.iteration(False):
                    GLib.usleep(20_000)
        finally:
            self._bus.signal_unsubscribe(sub)
        if "code" not in box:
            raise PortalError(f"{method}: no answer (did a permission dialog go unanswered?)")
        if box["code"] == 1:
            raise PortalError(f"{method}: Sir declined the permission dialog")
        if box["code"] != 0:
            raise PortalError(f"{method}: the portal refused (code {box['code']})")
        return box["results"]

    def _call(self, iface: str, method: str, sig: str, values: tuple) -> None:
        self._bus.call_sync(DESKTOP, PATH, iface, method, GLib.Variant(sig, values), None,
                            Gio.DBusCallFlags.NONE, -1, None)

    # --- screenshots ---------------------------------------------------------------------------
    def screenshot(self) -> Path:
        """Full-screen PNG, moved out of ~/Pictures into FRIDAY's own folder."""
        def go():
            res = self._request("org.freedesktop.portal.Screenshot", "Screenshot", "(sa{sv})",
                                ["", {"interactive": GLib.Variant("b", False)}], 20)
            src = Path(urllib.parse.unquote(urllib.parse.urlparse(res["uri"]).path))
            shots = STATE / "shots"
            shots.mkdir(parents=True, exist_ok=True)
            dest = shots / "latest.png"
            shutil.move(str(src), dest)
            os.chmod(dest, 0o600)
            return dest
        return self._run(go, timeout=30)

    # --- remote desktop (input) ----------------------------------------------------------------
    def ensure_session(self) -> None:
        with self._lock:
            if self.session:
                return
            self._run(self._start_session, timeout=120)

    def _start_session(self) -> None:
        RD, SC = "org.freedesktop.portal.RemoteDesktop", "org.freedesktop.portal.ScreenCast"
        res = self._request(RD, "CreateSession", "(a{sv})",
                            [{"session_handle_token": GLib.Variant("s", f"fridaysess{os.getpid()}")}], 20)
        session = res["session_handle"]
        dev_opts = {"types": GLib.Variant("u", 3), "persist_mode": GLib.Variant("u", 2)}
        if TOKEN_FILE.exists():
            dev_opts["restore_token"] = GLib.Variant("s", TOKEN_FILE.read_text().strip())
        self._request(RD, "SelectDevices", "(oa{sv})", [session, dev_opts], 20)
        self._request(SC, "SelectSources", "(oa{sv})", [session, {
            "types": GLib.Variant("u", 1), "multiple": GLib.Variant("b", False)}], 20)
        started = self._request(RD, "Start", "(osa{sv})", [session, "", {}], 90)
        token = started.get("restore_token")
        if token:
            STATE.mkdir(parents=True, exist_ok=True)
            TOKEN_FILE.write_text(token)
            os.chmod(TOKEN_FILE, 0o600)
        streams = started.get("streams") or []
        if not streams:
            raise PortalError("Remote Desktop started without a screen to point at")
        node, props = streams[0]
        x, y = props.get("position", (0, 0))
        w, h = props.get("size", (0, 0))
        self.session, self.stream = session, (node, x, y, w, h)

    def _rd(self, method: str, sig: str, make_values) -> None:
        """Send one input event; `make_values(session, node)` builds the arguments."""
        self.ensure_session()

        def go():
            try:
                self._call("org.freedesktop.portal.RemoteDesktop", method, sig,
                           make_values(self.session, self.stream[0]))
            except GLib.Error as e:
                # The session was closed (e.g. Sir pressed stop in the top bar): start fresh next time.
                self.session = None
                raise PortalError(f"Remote control stopped ({e.message}). Try again to reconnect.") from e
        self._run(go, timeout=10)

    def move(self, x: float, y: float) -> None:
        self._rd("NotifyPointerMotionAbsolute", "(oa{sv}udd)",
                 lambda s, node: (s, {}, node, float(x), float(y)))

    def button(self, name: str, pressed: bool) -> None:
        code = BUTTONS.get(name)
        if code is None:
            raise PortalError(f"Unknown mouse button: {name}")
        self._rd("NotifyPointerButton", "(oa{sv}iu)", lambda s, _n: (s, {}, code, 1 if pressed else 0))

    def scroll(self, steps: int) -> None:
        self._rd("NotifyPointerAxisDiscrete", "(oa{sv}ui)", lambda s, _n: (s, {}, 0, int(steps)))

    def keysym(self, sym: int, pressed: bool) -> None:
        self._rd("NotifyKeyboardKeysym", "(oa{sv}iu)", lambda s, _n: (s, {}, sym, 1 if pressed else 0))

    def stream_size(self) -> tuple[int, int, int, int]:
        self.ensure_session()
        _, x, y, w, h = self.stream
        return x, y, w, h
