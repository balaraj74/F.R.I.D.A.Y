#!/usr/bin/env python3
"""
🤖 FRIDAY System Automation
===========================
Control windows, apps, and system functions

Usage:
    python system.py window <move|resize|close|focus|list>
    python system.py app <open|close|list>
    python system.py clipboard <get|set> [text]
    python system.py brightness <up|down|set> [value]
    python system.py wifi <on|off|status>
    python system.py bluetooth <on|off|status>
    python system.py lock
    python system.py sleep
    python system.py shutdown
    python system.py restart
"""

import subprocess
import sys
import os
import json
from pathlib import Path


# ============ WINDOW MANAGEMENT ============
class WindowManager:
    """Control windows using wmctrl and xdotool."""
    
    def list_windows(self):
        """List all windows."""
        try:
            result = subprocess.run(
                ["wmctrl", "-l"],
                capture_output=True, text=True, timeout=5
            )
            windows = []
            for line in result.stdout.strip().split("\n"):
                if line:
                    parts = line.split(None, 3)
                    if len(parts) >= 4:
                        windows.append({
                            "id": parts[0],
                            "desktop": parts[1],
                            "host": parts[2],
                            "title": parts[3]
                        })
            return windows
        except:
            return []
    
    def focus_window(self, name):
        """Focus a window by name."""
        try:
            subprocess.run(["wmctrl", "-a", name], timeout=5)
            print(f"✅ Focused: {name}")
            return True
        except:
            return False
    
    def close_window(self, name):
        """Close a window by name."""
        try:
            subprocess.run(["wmctrl", "-c", name], timeout=5)
            print(f"✅ Closed: {name}")
            return True
        except:
            return False
    
    def move_window(self, direction):
        """Move active window to left/right half."""
        try:
            # Get screen resolution
            result = subprocess.run(
                ["xdpyinfo"],
                capture_output=True, text=True
            )
            width = 1920
            height = 1080
            for line in result.stdout.split("\n"):
                if "dimensions:" in line:
                    match = __import__('re').search(r'(\d+)x(\d+)', line)
                    if match:
                        width = int(match.group(1))
                        height = int(match.group(2))
            
            if direction == "left":
                subprocess.run([
                    "wmctrl", "-r", ":ACTIVE:",
                    "-e", f"0,0,0,{width//2},{height}"
                ], timeout=5)
            elif direction == "right":
                subprocess.run([
                    "wmctrl", "-r", ":ACTIVE:",
                    "-e", f"0,{width//2},0,{width//2},{height}"
                ], timeout=5)
            elif direction == "maximize":
                subprocess.run([
                    "wmctrl", "-r", ":ACTIVE:", "-b", "toggle,maximized_vert,maximized_horz"
                ], timeout=5)
            
            print(f"✅ Window moved {direction}")
            return True
        except:
            return False
    
    def minimize_window(self):
        """Minimize active window."""
        try:
            subprocess.run(["xdotool", "getactivewindow", "windowminimize"], timeout=5)
            print("✅ Window minimized")
            return True
        except:
            return False


# ============ APP CONTROL ============
class AppController:
    """Control applications."""
    
    APPS = {
        "chrome": "google-chrome",
        "browser": "google-chrome",
        "firefox": "firefox",
        "code": "code",
        "vscode": "code",
        "terminal": "gnome-terminal",
        "files": "nautilus",
        "spotify": "spotify",
        "settings": "gnome-control-center",
        "calculator": "gnome-calculator",
        "text": "gedit",
        "notepad": "gedit",
    }
    
    def open_app(self, name):
        """Open an application."""
        app = self.APPS.get(name.lower(), name)
        try:
            subprocess.Popen(
                [app],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL
            )
            print(f"✅ Opening {name}")
            return True
        except:
            print(f"❌ Could not open {name}")
            return False
    
    def close_app(self, name):
        """Close an application."""
        app = self.APPS.get(name.lower(), name)
        try:
            subprocess.run(["pkill", "-f", app], timeout=5)
            print(f"✅ Closed {name}")
            return True
        except:
            return False
    
    def list_apps(self):
        """List running applications."""
        try:
            result = subprocess.run(
                ["ps", "-eo", "comm", "--sort=-pcpu"],
                capture_output=True, text=True
            )
            apps = list(set(result.stdout.strip().split("\n")[1:21]))
            return apps
        except:
            return []


# ============ CLIPBOARD ============
class ClipboardController:
    """Control system clipboard."""
    
    def get(self):
        """Get clipboard content."""
        try:
            result = subprocess.run(
                ["xclip", "-selection", "clipboard", "-o"],
                capture_output=True, text=True, timeout=5
            )
            return result.stdout
        except:
            return None
    
    def set(self, text):
        """Set clipboard content."""
        try:
            process = subprocess.Popen(
                ["xclip", "-selection", "clipboard"],
                stdin=subprocess.PIPE
            )
            process.communicate(text.encode())
            print("✅ Clipboard set")
            return True
        except:
            return False


# ============ SYSTEM CONTROLS ============
class SystemController:
    """System-level controls."""
    
    def brightness(self, action, value=None):
        """Control screen brightness."""
        try:
            if action == "up":
                subprocess.run(["brightnessctl", "set", "+10%"], timeout=5)
            elif action == "down":
                subprocess.run(["brightnessctl", "set", "10%-"], timeout=5)
            elif action == "set" and value:
                subprocess.run(["brightnessctl", "set", f"{value}%"], timeout=5)
            print(f"✅ Brightness {action}")
            return True
        except:
            return False
    
    def wifi(self, action):
        """Control WiFi."""
        try:
            if action == "on":
                subprocess.run(["nmcli", "radio", "wifi", "on"], timeout=5)
            elif action == "off":
                subprocess.run(["nmcli", "radio", "wifi", "off"], timeout=5)
            elif action == "status":
                result = subprocess.run(
                    ["nmcli", "radio", "wifi"],
                    capture_output=True, text=True
                )
                print(f"WiFi: {result.stdout.strip()}")
                return result.stdout.strip()
            print(f"✅ WiFi {action}")
            return True
        except:
            return False
    
    def bluetooth(self, action):
        """Control Bluetooth."""
        try:
            if action == "on":
                subprocess.run(["bluetoothctl", "power", "on"], timeout=5)
            elif action == "off":
                subprocess.run(["bluetoothctl", "power", "off"], timeout=5)
            elif action == "status":
                result = subprocess.run(
                    ["bluetoothctl", "show"],
                    capture_output=True, text=True
                )
                powered = "Powered: yes" in result.stdout
                print(f"Bluetooth: {'on' if powered else 'off'}")
                return "on" if powered else "off"
            print(f"✅ Bluetooth {action}")
            return True
        except:
            return False
    
    def lock_screen(self):
        """Lock the screen."""
        try:
            subprocess.run(["gnome-screensaver-command", "-l"], timeout=5)
            print("✅ Screen locked")
            return True
        except:
            try:
                subprocess.run(["loginctl", "lock-session"], timeout=5)
                return True
            except:
                return False
    
    def sleep(self):
        """Put system to sleep."""
        try:
            subprocess.run(["systemctl", "suspend"], timeout=5)
            return True
        except:
            return False
    
    def shutdown(self, delay=0):
        """Shutdown the system."""
        print(f"⚠ System will shutdown in {delay} seconds...")
        subprocess.run(["shutdown", "-h", f"+{delay//60}" if delay > 0 else "now"])
    
    def restart(self):
        """Restart the system."""
        print("⚠ System will restart...")
        subprocess.run(["shutdown", "-r", "now"])


# ============ CLI ============
def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    
    cmd = sys.argv[1].lower()
    
    if cmd == "window":
        wm = WindowManager()
        if len(sys.argv) < 3:
            print("Usage: system.py window <move|close|focus|list>")
            return
        
        action = sys.argv[2].lower()
        
        if action == "list":
            windows = wm.list_windows()
            print(f"🪟 {len(windows)} windows:")
            for w in windows:
                print(f"  {w['title']}")
        
        elif action == "move" and len(sys.argv) > 3:
            wm.move_window(sys.argv[3])
        
        elif action == "focus" and len(sys.argv) > 3:
            wm.focus_window(" ".join(sys.argv[3:]))
        
        elif action == "close" and len(sys.argv) > 3:
            wm.close_window(" ".join(sys.argv[3:]))
        
        elif action == "minimize":
            wm.minimize_window()
        
        elif action == "maximize":
            wm.move_window("maximize")
    
    elif cmd == "app":
        app = AppController()
        if len(sys.argv) < 3:
            print("Usage: system.py app <open|close|list>")
            return
        
        action = sys.argv[2].lower()
        
        if action == "list":
            apps = app.list_apps()
            print(f"📱 Running apps: {', '.join(apps)}")
        
        elif action == "open" and len(sys.argv) > 3:
            app.open_app(sys.argv[3])
        
        elif action == "close" and len(sys.argv) > 3:
            app.close_app(sys.argv[3])
    
    elif cmd == "clipboard":
        clip = ClipboardController()
        if len(sys.argv) < 3:
            # Default: get
            print(clip.get())
        elif sys.argv[2].lower() == "get":
            print(clip.get())
        elif sys.argv[2].lower() == "set" and len(sys.argv) > 3:
            clip.set(" ".join(sys.argv[3:]))
    
    elif cmd == "brightness":
        sys_ctrl = SystemController()
        if len(sys.argv) < 3:
            print("Usage: system.py brightness <up|down|set> [value]")
        else:
            value = sys.argv[3] if len(sys.argv) > 3 else None
            sys_ctrl.brightness(sys.argv[2], value)
    
    elif cmd == "wifi":
        sys_ctrl = SystemController()
        action = sys.argv[2] if len(sys.argv) > 2 else "status"
        sys_ctrl.wifi(action)
    
    elif cmd == "bluetooth":
        sys_ctrl = SystemController()
        action = sys.argv[2] if len(sys.argv) > 2 else "status"
        sys_ctrl.bluetooth(action)
    
    elif cmd == "lock":
        SystemController().lock_screen()
    
    elif cmd == "sleep":
        SystemController().sleep()
    
    elif cmd == "shutdown":
        SystemController().shutdown()
    
    elif cmd == "restart":
        SystemController().restart()
    
    else:
        print(f"Unknown command: {cmd}")
        print(__doc__)


if __name__ == "__main__":
    main()
