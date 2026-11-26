#!/usr/bin/env python3
"""FRIDAY desktop MCP server: look at Sir's screen and use the mouse and keyboard.

Runs over stdio (started by FRIDAY's gateway). Screenshots and input go through GNOME's own
portals (see portal.py): Sir approves remote control once in a GNOME dialog, and GNOME shows
its top-bar indicator, with a stop button, whenever FRIDAY is in control.

Coordinates are always in the pixels of the last screenshot FRIDAY looked at.
"""

from __future__ import annotations

import io
import sys
import time
from pathlib import Path

from PIL import Image as PILImage

sys.path.insert(0, str(Path(__file__).resolve().parent))
from portal import KEYSYMS, Portal, PortalError, char_keysym, parse_combo  # noqa: E402

MAX_TYPE = 2000
SETTLE_S = 0.45  # let the screen redraw before looking again

portal = Portal()
# Size of the last image FRIDAY saw, so her coordinates can be mapped back to the screen.
last_view: dict[str, int] = {}


def look(max_width: int = 1280) -> tuple[bytes, str]:
    shot = portal.screenshot()
    with PILImage.open(shot) as im:
        im = im.convert("RGB")
        full_w, full_h = im.size
        width = max(480, min(int(max_width), full_w))
        if full_w > width:
            im = im.resize((width, round(full_h * width / full_w)), PILImage.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=82)
    last_view.update(w=im.size[0], h=im.size[1], full_w=full_w, full_h=full_h)
    note = (
        f"Screen {full_w}x{full_h}, shown at {im.size[0]}x{im.size[1]}. "
        "Give coordinates in this image's pixels."
    )
    return buf.getvalue(), note


def to_stream(x: float, y: float) -> tuple[float, float]:
    """A point in the last screenshot -> the Remote Desktop stream's coordinates."""
    if not last_view:
        raise PortalError("Look at the screen first (screen_look), then use coordinates from that image.")
    if not (0 <= x <= last_view["w"] and 0 <= y <= last_view["h"]):
        raise PortalError(f"({x}, {y}) is outside the last screenshot ({last_view['w']}x{last_view['h']}).")
    sx, sy, sw, sh = portal.stream_size()
    return x * sw / last_view["w"] - sx, y * sh / last_view["h"] - sy


def make_server():
    import functools

    from mcp.server.mcpserver import MCPServer
    from mcp.server.mcpserver.exceptions import ToolError
    from mcp.server.mcpserver.utilities.types import Image

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
        if not look_after:
            return note
        time.sleep(SETTLE_S)
        data, view = look()
        return [Image(data=data, format="jpeg"), f"{note} Now: {view}"]

    @tool
    def screen_look(max_width: int = 1280):
        """See Sir's screen right now (a screenshot). Use it to answer questions about what's on
        screen, and always before clicking: coordinates for the other screen_* tools are pixels in
        the most recent screenshot. Never read out passwords or private details you happen to see."""
        data, note = look(max_width)
        return [Image(data=data, format="jpeg"), note]

    @tool
    def screen_click(x: float, y: float, button: str = "left", double: bool = False, look_after: bool = True):
        """Click at (x, y) in the last screenshot's pixels. button: left, right or middle.
        Before clicking anything that sends, submits, pays, buys, deletes or posts, stop and ask Sir."""
        px, py = to_stream(x, y)
        portal.move(px, py)
        time.sleep(0.05)
        for _ in range(2 if double else 1):
            portal.button(button, True)
            time.sleep(0.03)
            portal.button(button, False)
            time.sleep(0.06)
        return result(f"{'Double-clicked' if double else 'Clicked'} {button} at ({x:.0f}, {y:.0f}).", look_after)

    @tool
    def screen_type(text: str, look_after: bool = False):
        """Type text into whatever has keyboard focus (click the field first). Never type
        passwords, card numbers or other secrets: ask Sir to type those himself."""
        if len(text) > MAX_TYPE:
            raise PortalError(f"That's {len(text)} characters; type at most {MAX_TYPE} at a time.")
        for ch in text:
            sym = char_keysym(ch)
            portal.keysym(sym, True)
            portal.keysym(sym, False)
            time.sleep(0.008)
        return result(f"Typed {len(text)} characters.", look_after)

    @tool
    def screen_key(keys: str, look_after: bool = True):
        """Press a key or shortcut, e.g. "Return", "Escape", "ctrl+l", "ctrl+shift+t", "alt+tab",
        "super" (opens Activities). Keys in a combo are joined with +."""
        syms = parse_combo(keys)
        for sym in syms:
            portal.keysym(sym, True)
            time.sleep(0.02)
        for sym in reversed(syms):
            portal.keysym(sym, False)
            time.sleep(0.02)
        return result(f"Pressed {keys}.", look_after)

    @tool
    def screen_scroll(x: float, y: float, direction: str = "down", amount: int = 3, look_after: bool = True):
        """Scroll at (x, y) in the last screenshot's pixels. direction: up or down; amount: notches (1-15)."""
        steps = max(1, min(int(amount), 15)) * (1 if direction.lower() != "up" else -1)
        px, py = to_stream(x, y)
        portal.move(px, py)
        time.sleep(0.05)
        portal.scroll(steps)
        return result(f"Scrolled {direction} {abs(steps)} at ({x:.0f}, {y:.0f}).", look_after)

    return server


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "check":
        data, note = look()
        print(note, f"{len(data) // 1024} KB")
    else:
        make_server().run()
