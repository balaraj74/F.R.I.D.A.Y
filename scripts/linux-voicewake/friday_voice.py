#!/usr/bin/env python3
"""
🎙️ FRIDAY v5.0 - Ultimate AI Agent
===================================
Ultra-fast, intelligent, offline-capable voice assistant.

Features:
- Local wake word detection (Vosk) - INSTANT
- Hybrid TTS (local Piper + Edge TTS fallback)
- Smart memory system
- Phone control
- Communication hub
- System automation
"""

import os
import sys
import subprocess
import json
import time
import random
import asyncio
import tempfile
import threading
import re
from datetime import datetime, timedelta
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from queue import Queue

# Import ARIA AGI Core
try:
    sys.path.insert(0, str(Path(__file__).parent.parent / "friday-agi"))
    from aria_core import ARIACore
    ARIA_AVAILABLE = True
except ImportError:
    ARIA_AVAILABLE = False
    print("⚠ ARIA Core not found — running in basic mode")

# Suppress ALSA warnings
os.environ['PYTHONWARNINGS'] = 'ignore'
try:
    from ctypes import *
    ERROR_HANDLER_FUNC = CFUNCTYPE(None, c_char_p, c_int, c_char_p, c_int, c_char_p)
    c_error_handler = ERROR_HANDLER_FUNC(lambda *args: None)
    try:
        asound = cdll.LoadLibrary('libasound.so.2')
        asound.snd_lib_error_set_handler(c_error_handler)
    except: pass
except: pass

import warnings
warnings.filterwarnings('ignore')

import requests
import speech_recognition as sr

# Try to import Vosk for local speech recognition
try:
    from vosk import Model, KaldiRecognizer
    VOSK_AVAILABLE = True
except ImportError:
    VOSK_AVAILABLE = False
    print("⚠ Vosk not available, using Google Speech API")

# Try to import Edge TTS (fallback)
try:
    import edge_tts
    EDGE_TTS_AVAILABLE = True
except ImportError:
    EDGE_TTS_AVAILABLE = False


class Colors:
    GREEN = '\033[92m'
    CYAN = '\033[96m'
    YELLOW = '\033[93m'
    RED = '\033[91m'
    MAGENTA = '\033[95m'
    DIM = '\033[90m'
    BOLD = '\033[1m'
    END = '\033[0m'


# ============ PATHS ============
FRIDAY_DIR = Path.home() / ".friday"
VOICE_DIR = FRIDAY_DIR / "voice"
MEMORY_DIR = FRIDAY_DIR / "memory"
CACHE_DIR = FRIDAY_DIR / "cache" / "tts"
VOSK_MODEL_PATH = VOICE_DIR / "vosk-model"

# Ensure directories exist
for d in [VOICE_DIR, MEMORY_DIR, CACHE_DIR]:
    d.mkdir(parents=True, exist_ok=True)


# ============ QUICK DATA (time-sensitive, no AI needed) ============
QUICK_DATA_TRIGGERS = {
    "what time": "time",
    "what's the time": "time",
    "tell me the time": "time",
    "what date": "date",
    "what's the date": "date",
    "what day": "day",
    "what's today": "day",
}


# ============ SMART MEMORY SYSTEM ============
class SmartMemory:
    """Persistent memory for FRIDAY - remembers conversations and preferences."""
    
    def __init__(self):
        self.conversations_file = MEMORY_DIR / "conversations.json"
        self.preferences_file = MEMORY_DIR / "preferences.json"
        self.notes_file = MEMORY_DIR / "notes.json"
        
        self.conversations = self._load(self.conversations_file, [])
        self.preferences = self._load(self.preferences_file, {})
        self.notes = self._load(self.notes_file, [])
    
    def _load(self, path, default):
        try:
            if path.exists():
                with open(path) as f:
                    return json.load(f)
        except:
            pass
        return default
    
    def _save(self, path, data):
        try:
            with open(path, 'w') as f:
                json.dump(data, f, indent=2, default=str)
        except Exception as e:
            print(f"{Colors.DIM}Memory save error: {e}{Colors.END}")
    
    def remember_conversation(self, user_input, response):
        """Store conversation for future recall."""
        self.conversations.append({
            "time": datetime.now().isoformat(),
            "user": user_input,
            "friday": response
        })
        # Keep last 100 conversations
        self.conversations = self.conversations[-100:]
        self._save(self.conversations_file, self.conversations)
    
    def add_note(self, content):
        """Add a quick note."""
        self.notes.append({
            "time": datetime.now().isoformat(),
            "content": content
        })
        self._save(self.notes_file, self.notes)
    
    def get_notes(self, limit=5):
        """Get recent notes."""
        return self.notes[-limit:] if self.notes else []
    
    def get_preference(self, key, default=None):
        """Get a user preference."""
        return self.preferences.get(key, default)
    
    def set_preference(self, key, value):
        """Set a user preference."""
        self.preferences[key] = value
        self._save(self.preferences_file, self.preferences)
    
    def get_recent_context(self, limit=5):
        """Get recent conversation context."""
        return self.conversations[-limit:] if self.conversations else []


# ============ HYBRID TTS ============
class HybridTTS:
    """Fast TTS with Piper (local) + Edge TTS (cloud) fallback."""
    
    EDGE_VOICE = "en-IN-NeerjaNeural"
    
    def __init__(self):
        self.executor = ThreadPoolExecutor(max_workers=2)
        self.cache = {}
        # Check for Piper
        self.use_piper = False
        self.piper_path = None
        try:
            # Check if piper binary exists in venv or system
            piper_check = subprocess.run(["which", "piper"], capture_output=True, text=True)
            if piper_check.returncode == 0:
                self.piper_path = piper_check.stdout.strip()
                self.use_piper = True
                print(f"{Colors.GREEN}✅ Piper TTS enabled (Local & Fast){Colors.END}")
            else:
                print(f"{Colors.YELLOW}⚠ Piper not found, using Edge TTS{Colors.END}")
        except:
            pass
            
        self._precache_common()
    
    def _precache_common(self):
        """Pre-cache common phrases."""
        common = [
            "Yes, Sir?", "I'm here!", "On it!", "Done!",
            "Opening!", "Playing!", "Got it!", "Of course!",
            "Calling now!", "Sending message!", "Answering!"
        ]
        for phrase in common:
            self.executor.submit(self._cache_phrase, phrase)
    
    def _cache_phrase(self, text):
        """Cache a phrase to file."""
        try:
            cache_file = CACHE_DIR / f"tts_{hash(text)}.mp3"
            if not cache_file.exists():
                if self.use_piper:
                    self._generate_piper(text, str(cache_file))
                elif EDGE_TTS_AVAILABLE:
                    asyncio.run(self._generate_edge(text, str(cache_file)))
            self.cache[text] = str(cache_file)
        except:
            pass
    
    def _generate_piper(self, text, path):
        """Generate speech using Piper (Local)."""
        # Echo text | piper --model ... --output_file ...
        # We need a voice model. Assuming phase 1 downloaded "en_IN-pavani-medium"
        # Usually it downloads to current dir or where we ran it
        # Let's try standard pipe approach
        cmd = f'echo "{text}" | piper --model en_IN-pavani-medium --output_file "{path}"'
        try:
            subprocess.run(cmd, shell=True, check=True, stderr=subprocess.DEVNULL)
        except:
            # Fallback to edge if piper fails
            if EDGE_TTS_AVAILABLE:
                asyncio.run(self._generate_edge(text, path))

    async def _generate_edge(self, text, path):
        """Generate speech using Edge TTS."""
        communicate = edge_tts.Communicate(text, self.EDGE_VOICE, rate="+5%")
        await communicate.save(path)
    
    def speak(self, text):
        """Speak text - uses cache if available."""
        print(f"{Colors.DIM}🗣️ Speaking: {text}{Colors.END}")
        
        # Check cache
        if text in self.cache and Path(self.cache[text]).exists():
            self._play(self.cache[text])
            return
        
        # Generate new audio
        try:
            with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
                audio_path = f.name
            
            if self.use_piper:
                 self._generate_piper(text, audio_path)
            elif EDGE_TTS_AVAILABLE:
                 asyncio.run(self._generate_edge(text, audio_path))
            else:
                 # Fallback to espeak
                 subprocess.run(["espeak", text], capture_output=True, timeout=10)
                 return
            
            self._play(audio_path)
            
            # Cache for future use if short
            if len(text) < 50:
                self.cache[text] = audio_path
        except Exception as e:
            print(f"{Colors.RED}TTS error: {e}{Colors.END}")
            # Ultra fallback
            os.system(f'espeak "{text}" &')
    
    def _play(self, path):
        """Play audio file."""
        try:
            # Use mpv or paplay
            if path.endswith(".wav"):
                subprocess.run(["paplay", path], timeout=30, stderr=subprocess.DEVNULL)
            else:
                subprocess.run(
                    ["mpv", "--no-video", "--really-quiet", "--speed=1.1", path],
                    timeout=30, stderr=subprocess.DEVNULL
                )
        except Exception as e:
            print(f"{Colors.RED}Play error: {e}{Colors.END}")
    
    def beep(self):
        """Quick beep for wake word acknowledgment."""
        try:
            subprocess.Popen(
                ["paplay", "/usr/share/sounds/freedesktop/stereo/message.oga"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )
        except:
            print("Beep!")


# ============ HYBRID SPEECH RECOGNITION ============
class HybridRecognizer:
    """Fast speech recognition - uses Google API (more reliable)."""
    
    def __init__(self):
        self.recognizer = sr.Recognizer()
        self.mic = sr.Microphone()
        
        # Vosk for local (optional, can have issues)
        self.vosk_model = None
        self.use_vosk = False  # Disabled by default - Google is more reliable
        
        if self.use_vosk and VOSK_AVAILABLE and VOSK_MODEL_PATH.exists():
            try:
                self.vosk_model = Model(str(VOSK_MODEL_PATH))
                print(f"{Colors.GREEN}✅ Vosk: Local speech recognition ready{Colors.END}")
            except Exception as e:
                print(f"{Colors.YELLOW}⚠ Vosk init failed, using Google{Colors.END}")
        
        # Configure recognizer - balanced settings for accuracy
        self.recognizer.energy_threshold = 400  # Slightly higher to reduce noise
        self.recognizer.dynamic_energy_threshold = True  # Auto-adjust
        self.recognizer.pause_threshold = 0.8  # Wait longer for complete phrases
        self.recognizer.phrase_threshold = 0.3  # Higher to avoid fragments
        self.recognizer.non_speaking_duration = 0.5  # Wait longer before cutting off
        
        print(f"{Colors.YELLOW}🎤 Calibrating microphone...{Colors.END}")
        with self.mic as source:
            self.recognizer.adjust_for_ambient_noise(source, duration=1.0)
        
        # Cap the threshold to ensure sensitivity
        if self.recognizer.energy_threshold > 1000:
            self.recognizer.energy_threshold = 600
        
        print(f"{Colors.GREEN}✅ Microphone ready (threshold: {int(self.recognizer.energy_threshold)}){Colors.END}")
    
    def _normalize_wake_word(self, text):
        """Normalize text to catch accent variations."""
        # Replace common mishears
        replacements = {
            "fry day": "friday", "fry de": "friday", "fryday": "friday",
            "free day": "friday", "fri day": "friday", "for a day": "friday",
            "for day": "friday", "fried a": "friday", "bride a": "friday",
            "pridey": "friday", "pridy": "friday", "fridae": "friday",
            "freddy": "friday", "freddie": "friday", "phraiday": "friday",
            "vriday": "friday", "vryday": "friday", "fraidy": "friday",
        }
        result = text.lower()
        for wrong, right in replacements.items():
            result = result.replace(wrong, right)
        return result
    
    def _sounds_like_friday(self, text):
        """Check if text sounds like 'friday' using fuzzy matching."""
        text = text.lower().strip()
        
        # Direct substring check
        friday_sounds = [
            "fri", "fry", "frai", "fray", "phri", "vri",
            "prid", "fred", "bride", "freed"
        ]
        
        # Check if any friday-like sound is in the text
        for sound in friday_sounds:
            if sound in text:
                # Make sure it's not in the middle of another word incorrectly
                # Check if followed by day-like sounds
                idx = text.find(sound)
                remaining = text[idx + len(sound):]
                day_sounds = ["day", "de", "dy", "di", "dey", "dei", "da", "d "]
                for day in day_sounds:
                    if remaining.startswith(day) or day in remaining[:5]:
                        return True
        
        # Check for isolated "friday" with spaces
        words = text.split()
        for word in words:
            if len(word) >= 4:
                # Check similarity to "friday"
                if word.startswith("fr") or word.startswith("pr") or word.startswith("vr"):
                    if "day" in word or "de" in word or "dy" in word or "di" in word:
                        return True
        
        return False
    
    def listen_wake_google(self, wake_words):
        """Listen for wake word using Google (reliable)."""
        with self.mic as source:
            try:
                print(f"\r{Colors.DIM}👂 Listening for 'Friday'...{Colors.END}  ", end="", flush=True)
                audio = self.recognizer.listen(source, timeout=None, phrase_time_limit=3)
                
                try:
                    # Use Indian English for better accent recognition
                    text = self.recognizer.recognize_google(audio, language="en-IN").lower()
                    print(f"\r{Colors.DIM}Heard: '{text}'{Colors.END}              ")
                    
                    # Normalize text for better matching
                    normalized = self._normalize_wake_word(text)
                    
                    for wake in wake_words:
                        if wake in text or wake in normalized:
                            return True, text
                    
                    # Fuzzy match - if it sounds like "friday"
                    if self._sounds_like_friday(text):
                        return True, text
                    
                    return False, text
                except sr.UnknownValueError:
                    return False, None
                except sr.RequestError as e:
                    print(f"\r{Colors.RED}API error: {e}{Colors.END}")
                    return False, None
            except sr.WaitTimeoutError:
                return False, None
            except Exception as e:
                print(f"\r{Colors.DIM}Listen error: {e}{Colors.END}")
                return False, None
    
    def listen_command(self, timeout=5):
        """Listen for command after wake word.
        
        Uses multi-language recognition for better Indian accent handling:
        1. Try en-IN (Indian English) first
        2. Fall back to en-US if en-IN fails or returns garbled text
        """
        with self.mic as source:
            try:
                print(f"{Colors.CYAN}🎤 Listening for command...{Colors.END}")
                audio = self.recognizer.listen(source, timeout=timeout, phrase_time_limit=8)
                
                # Try Indian English first (best for Indian accents)
                text = None
                try:
                    text = self.recognizer.recognize_google(audio, language="en-IN")
                except sr.UnknownValueError:
                    pass
                
                # If Indian English failed or gave very short garbled result, try US English
                if not text or (len(text) <= 2 and not text.lower() in ['hi', 'ok', 'no']):
                    try:
                        text = self.recognizer.recognize_google(audio, language="en-US")
                    except sr.UnknownValueError:
                        pass
                
                if text:
                    text = self._clean_recognition(text)
                return text
                
            except sr.UnknownValueError:
                return None
            except sr.RequestError:
                return None
            except Exception:
                return None
    
    def _clean_recognition(self, text):
        """Clean up common voice recognition errors, especially for Indian accents."""
        if not text:
            return text
        
        # Common Indian accent misrecognitions → corrections
        corrections = {
            # App names
            "radio open": "telegram",
            "hologram": "telegram",
            "kilogram": "telegram",
            "telegraph": "telegram",
            "today open": "telegram",
            "video open": "telegram",
            "tell a gram": "telegram",
            "tele gram": "telegram",
            "what's up": "whatsapp",
            "what sup": "whatsapp",
            "what's app": "whatsapp",
            "what sap": "whatsapp",
            "sports fire": "spotify",
            "spot a fight": "spotify",
            "spot if i": "spotify",
            # Tech terms (commonly misheard)
            "krishna": "codex",  
            "codec": "codex",
            "kodak": "codex",
            "kodaks": "codex",
            "code x": "codex",
            "code axe": "codex",
            "cold x": "codex",
            "cold ex": "codex",
            "cortex": "codex",
            "index": "codex",
            "debag": "debug",
            "the bag": "debug",
            "de bug": "debug",
            "re factor": "refactor",
            # Commands
            "bill the": "build a",
            "billed a": "build a",
            "billed me": "build me",
            "cold me": "code me",
            "coat a": "code a",
            "court a": "code a",
            "right a": "write a",
            "ride a": "write a",
            "rate a": "write a",
            # Common phrase fixes
            "what is the": "what's the",
            "turn of": "turn off",
            "turn on of": "turn off",
            "shut down": "shutdown",
            "screen shot": "screenshot",
            "screen short": "screenshot",
        }
        
        text_lower = text.lower()
        for wrong, right in corrections.items():
            if wrong in text_lower:
                text = text_lower.replace(wrong, right)
                text_lower = text.lower()  # Update for cascading fixes
        
        return text


# ============ ACTION EXECUTOR ============
class ActionExecutor:
    """Execute system actions."""
    
    PHONE_SCRIPT = Path.home() / "F.R.I.D.A.Y/F.R.I.D.A.Y/skills/phone-control/scripts/phone.py"
    
    def __init__(self, memory):
        self.memory = memory
        self.executor = ThreadPoolExecutor(max_workers=3)
    
    def execute(self, command):
        """Execute a command and return response."""
        cmd = command.lower()
        
        try:
            # ============ MUSIC CONTROL ============
            if "spotify" in cmd:
                if any(x in cmd for x in ["open", "launch"]):
                    subprocess.Popen(["spotify"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    return "Opening Spotify!"
                elif any(x in cmd for x in ["play", "resume"]):
                    subprocess.run(["playerctl", "-p", "spotify", "play"], timeout=3)
                    return "Playing!"
                elif any(x in cmd for x in ["pause", "stop"]):
                    subprocess.run(["playerctl", "-p", "spotify", "pause"], timeout=3)
                    return "Paused!"
                elif "next" in cmd or "skip" in cmd:
                    subprocess.run(["playerctl", "-p", "spotify", "next"], timeout=3)
                    return "Next track!"
            
            # General music
            if any(x in cmd for x in ["play music", "resume music", "play the music"]):
                subprocess.run(["playerctl", "play"], timeout=3)
                return "Playing your music!"
            if any(x in cmd for x in ["pause", "stop music", "stop the music"]):
                subprocess.run(["playerctl", "pause"], timeout=3)
                return "Paused!"
            if any(x in cmd for x in ["next song", "skip", "next track"]):
                subprocess.run(["playerctl", "next"], timeout=3)
                return "Next track!"
            
            # ============ VOLUME ============
            if "volume" in cmd:
                if "up" in cmd or "increase" in cmd:
                    subprocess.run(["pactl", "set-sink-volume", "@DEFAULT_SINK@", "+10%"], timeout=2)
                    return "Volume up!"
                elif "down" in cmd or "decrease" in cmd:
                    subprocess.run(["pactl", "set-sink-volume", "@DEFAULT_SINK@", "-10%"], timeout=2)
                    return "Volume down!"
                elif "mute" in cmd:
                    subprocess.run(["pactl", "set-sink-mute", "@DEFAULT_SINK@", "toggle"], timeout=2)
                    return "Muted!"
                elif "max" in cmd:
                    subprocess.run(["pactl", "set-sink-volume", "@DEFAULT_SINK@", "100%"], timeout=2)
                    return "Maximum volume!"
            
            # ============ APPS ============
            # Map common names to actual binary names
            APP_MAP = {
                "chrome": "google-chrome",
                "browser": "google-chrome",
                "code": "code",
                "vscode": "code",
                "terminal": "gnome-terminal",
                "files": "nautilus",
                "file manager": "nautilus",
                "spotify": "spotify",
                "telegram": "telegram-desktop",
                "discord": "discord",
                "calculator": "gnome-calculator",
                "settings": "gnome-control-center",
                "text": "gedit",
                "notepad": "gedit"
            }

            if "open" in cmd:
                target = cmd.replace("open", "").strip()
                
                # Check specific map first
                if target in APP_MAP:
                    app_cmd = APP_MAP[target]
                    subprocess.Popen([app_cmd], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    return f"Opening {target}!"
                
                # Check known apps in "apps" commands
                if "telegram" in target:
                     subprocess.Popen(["gtk-launch", "telegram-desktop"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                     return "Opening Telegram!"
                
                if "whatsapp" in target:
                    subprocess.Popen(["xdg-open", "https://web.whatsapp.com"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    return "Opening WhatsApp!"
                
                if "youtube" in target:
                    subprocess.Popen(["xdg-open", "https://youtube.com"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    return "Opening YouTube!"
                
                # ============ MOBILE PHONE CONTROL (via ADB) ============
                if "mobile" in cmd or "phone" in cmd or "my phone" in cmd:
                    # Map app names to package names
                    MOBILE_APPS = {
                        "telegram": "org.telegram.messenger",
                        "whatsapp": "com.whatsapp",
                        "youtube": "com.google.android.youtube",
                        "chrome": "com.android.chrome",
                        "instagram": "com.instagram.android",
                        "spotify": "com.spotify.music",
                        "camera": "com.android.camera2",
                        "settings": "com.android.settings",
                        "gmail": "com.google.android.gm",
                        "maps": "com.google.android.apps.maps",
                        "messages": "com.google.android.apps.messaging",
                        "phone": "com.android.dialer",
                        "photos": "com.google.android.apps.photos",
                        "play store": "com.android.vending",
                        "clock": "com.google.android.deskclock",
                        "calendar": "com.google.android.calendar"
                    }
                    
                    # Find which app to open
                    for app_name, package in MOBILE_APPS.items():
                        if app_name in target.lower():
                            try:
                                subprocess.run(
                                    ["adb", "shell", "monkey", "-p", package, 
                                     "-c", "android.intent.category.LAUNCHER", "1"],
                                    capture_output=True, timeout=5
                                )
                                return f"Opening {app_name.title()} on your phone!"
                            except Exception as e:
                                print(f"{Colors.DIM}ADB error: {e}{Colors.END}")
                                return "Couldn't connect to your phone. Check ADB connection."
                    
                    # Generic app attempt
                    app_guess = target.replace("on my mobile", "").replace("on my phone", "").replace("on mobile", "").replace("on phone", "").strip()
                    if app_guess:
                        # Try common variations
                        for app_name, package in MOBILE_APPS.items():
                            if app_name in app_guess or app_guess in app_name:
                                try:
                                    subprocess.run(
                                        ["adb", "shell", "monkey", "-p", package,
                                         "-c", "android.intent.category.LAUNCHER", "1"],
                                        capture_output=True, timeout=5
                                    )
                                    return f"Opening {app_name.title()} on your phone!"
                                except:
                                    pass
                        return f"I don't know how to open {app_guess} on your phone."

                # ============ FUZZY MATCHING FOR TELEGRAM ============
                # Fixes: "radio open", "today open", "video open", "hologram", etc.
                if any(x in target for x in ["telegram", "tele", "gram", "today", "radio", "video", "hologram", "kilogram", "telegraph"]):
                     subprocess.Popen(["gtk-launch", "telegram-desktop"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                     return "Opening Telegram!"

                # Try generic launch
                if target:
                    try:
                        # Try gtk-launch first (better for GUI apps)
                        subprocess.Popen(["gtk-launch", target], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                        return f"Opening {target}!"
                    except:
                        try:
                            # Fallback to binary execution
                            subprocess.Popen([target], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                            return f"Opening {target}!"
                        except:
                            pass
            
            # ============ SCREENSHOT ============
            if "screenshot" in cmd:
                # Phone screenshot
                if "phone" in cmd or "mobile" in cmd:
                    try:
                        # Take screenshot on phone
                        subprocess.run(["adb", "shell", "screencap", "/sdcard/friday_screenshot.png"], timeout=5)
                        # Pull to computer
                        screenshot_path = Path.home() / "Pictures" / f"phone_screenshot_{int(time.time())}.png"
                        subprocess.run(["adb", "pull", "/sdcard/friday_screenshot.png", str(screenshot_path)], timeout=10)
                        
                        # Check if user wants to send it
                        if "send" in cmd:
                            # Open in default viewer or prepare for sharing
                            subprocess.Popen(["xdg-open", str(screenshot_path)])
                            return f"Phone screenshot saved and opened: {screenshot_path.name}"
                        return f"Phone screenshot saved to {screenshot_path.name}!"
                    except Exception as e:
                        print(f"{Colors.DIM}Phone screenshot error: {e}{Colors.END}")
                        return "Couldn't take phone screenshot. Check ADB connection."
                else:
                    # Desktop screenshot
                    try:
                        screenshot_path = Path.home() / "Pictures" / f"screenshot_{int(time.time())}.png"
                        subprocess.run(["scrot", str(screenshot_path)], timeout=3)
                        return f"Screenshot saved to {screenshot_path.name}!"
                    except:
                        try:
                            subprocess.run(["gnome-screenshot"], timeout=3)
                            return "Screenshot taken!"
                        except:
                            return "Couldn't take screenshot. Install scrot or gnome-screenshot."
            
            # ============ SEARCH ============
            if "search" in cmd or "google" in cmd:
                query = cmd.replace("search", "").replace("google", "").replace("for", "").strip()
                if query:
                    subprocess.Popen(["xdg-open", f"https://google.com/search?q={query}"])
                    return f"Searching for {query}!"
            
            # ============ PHONE CONTROL ============
            if "call" in cmd:
                name = cmd.replace("call", "").replace("to", "").strip()
                if name:
                    result = subprocess.run(
                        ["python3", str(self.PHONE_SCRIPT), "call", name],
                        capture_output=True, text=True, timeout=15
                    )
                    # Check if actual call started
                    if result.returncode == 0 and "Calling" in result.stdout:
                        return f"Calling {name}!"
                    elif "not found" in result.stdout:
                        return f"Contact {name} not found."
                    else:
                        print(f"Phone error: {result.stdout}")
                        return "I couldn't make the call. Check the connection."
            
            if any(x in cmd for x in ["text", "message", "sms"]):
                match = re.search(r'(?:text|message|sms)\s+(\w+)\s+(.+)', cmd)
                if match:
                    name, message = match.group(1), match.group(2)
                    subprocess.run(
                        ["python3", str(self.PHONE_SCRIPT), "sms", name, message],
                        capture_output=True, text=True, timeout=15
                    )
                    return f"Sending message to {name}!"
            
            if "answer" in cmd:
                subprocess.run(["python3", str(self.PHONE_SCRIPT), "answer"], timeout=5)
                return "Answering the call!"
            
            if any(x in cmd for x in ["hang up", "hangup", "end call"]):
                subprocess.run(["python3", str(self.PHONE_SCRIPT), "hangup"], timeout=5)
                return "Call ended!"
            
            # ============ NOTES ============
            if any(x in cmd for x in ["note", "remember"]):
                note = cmd.replace("note", "").replace("remember", "").replace("that", "").strip()
                if note:
                    self.memory.add_note(note)
                    return f"I'll remember that: {note}"
            
            if "my notes" in cmd or "show notes" in cmd:
                notes = self.memory.get_notes()
                if notes:
                    return "Your notes: " + ", ".join([n["content"] for n in notes])
                return "You don't have any notes yet."
            
            # ============ TIME/DATE ============
            if "time" in cmd:
                return f"It's {datetime.now().strftime('%I:%M %p')}"
            if "date" in cmd:
                return f"Today is {datetime.now().strftime('%B %d, %Y')}"
            if "day" in cmd:
                return f"Today is {datetime.now().strftime('%A')}"
            
            # ============ GENERIC OPEN ============
            if "open" in cmd:
                app = cmd.replace("open", "").strip()
                if app:
                    try:
                        subprocess.Popen([app], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                        return f"Opening {app}!"
                    except:
                        pass
            
            # ============ SYSTEM AUTOMATION ============
            SYSTEM_SCRIPT = Path.home() / "F.R.I.D.A.Y/F.R.I.D.A.Y/skills/system-automation/scripts/system.py"
            COMM_SCRIPT = Path.home() / "F.R.I.D.A.Y/F.R.I.D.A.Y/skills/communication-hub/scripts/comm.py"
            
            # Window control
            if "window" in cmd:
                if "left" in cmd:
                    subprocess.run(["python3", str(SYSTEM_SCRIPT), "window", "move", "left"], timeout=5)
                    return "Window moved left!"
                elif "right" in cmd:
                    subprocess.run(["python3", str(SYSTEM_SCRIPT), "window", "move", "right"], timeout=5)
                    return "Window moved right!"
                elif "maximize" in cmd:
                    subprocess.run(["python3", str(SYSTEM_SCRIPT), "window", "maximize"], timeout=5)
                    return "Window maximized!"
                elif "minimize" in cmd:
                    subprocess.run(["python3", str(SYSTEM_SCRIPT), "window", "minimize"], timeout=5)
                    return "Window minimized!"
            
            # Brightness
            if "brightness" in cmd:
                if "up" in cmd or "increase" in cmd:
                    subprocess.run(["python3", str(SYSTEM_SCRIPT), "brightness", "up"], timeout=5)
                    return "Brightness increased!"
                elif "down" in cmd or "decrease" in cmd:
                    subprocess.run(["python3", str(SYSTEM_SCRIPT), "brightness", "down"], timeout=5)
                    return "Brightness decreased!"
            
            # WiFi
            if "wifi" in cmd:
                if "on" in cmd or "enable" in cmd:
                    subprocess.run(["python3", str(SYSTEM_SCRIPT), "wifi", "on"], timeout=5)
                    return "WiFi turned on!"
                elif "off" in cmd or "disable" in cmd:
                    subprocess.run(["python3", str(SYSTEM_SCRIPT), "wifi", "off"], timeout=5)
                    return "WiFi turned off!"
            
            # Bluetooth
            if "bluetooth" in cmd:
                if "on" in cmd or "enable" in cmd:
                    subprocess.run(["python3", str(SYSTEM_SCRIPT), "bluetooth", "on"], timeout=5)
                    return "Bluetooth turned on!"
                elif "off" in cmd or "disable" in cmd:
                    subprocess.run(["python3", str(SYSTEM_SCRIPT), "bluetooth", "off"], timeout=5)
                    return "Bluetooth turned off!"
            
            # Lock screen
            if "lock" in cmd and ("screen" in cmd or "computer" in cmd or "laptop" in cmd):
                subprocess.run(["python3", str(SYSTEM_SCRIPT), "lock"], timeout=5)
                return "Locking screen!"
            
            # WhatsApp
            if "whatsapp" in cmd and "send" in cmd:
                match = re.search(r'whatsapp\s+(?:send\s+)?(?:to\s+)?(\w+)\s+(.+)', cmd)
                if match:
                    name, message = match.group(1), match.group(2)
                    subprocess.run(["python3", str(COMM_SCRIPT), "whatsapp", "send", name, message], timeout=15)
                    return f"Sending WhatsApp to {name}!"
            
            # Email
            if "email" in cmd:
                subprocess.run(["python3", str(COMM_SCRIPT), "email", "read"], timeout=5)
                return "Opening your email!"
            
            return None
        except Exception as e:
            print(f"{Colors.DIM}Action error: {e}{Colors.END}")
            return None
    
    def is_action(self, text):
        """Check if text is an action command."""
        action_words = [
            "open", "play", "pause", "stop", "next", "skip", "volume",
            "screenshot", "search", "launch", "close", "mute",
            "call", "text", "message", "sms", "answer", "hang up",
            "note", "remember", "time", "date", "day",
            "window", "brightness", "wifi", "bluetooth", "lock",
            "whatsapp", "email", "maximize", "minimize",
            "mobile", "phone", "my phone"  # Added for mobile control
        ]
        return any(word in text.lower() for word in action_words)


# ============ CODEX CLI INTEGRATION ============
class CodexIntegration:
    """Voice-triggered Codex CLI integration for FRIDAY.

    Voice commands:
    - "Codex build a snake game"  → creates project, runs codex exec
    - "Code a REST API"           → routes to Codex for coding
    - "Codex review"              → reviews latest project
    - "Codex status"              → checks background tasks
    - "Build me a todo app"       → auto-detects coding intent
    """

    DEFAULT_PROJECT_DIR = Path.home() / "Projects"

    def __init__(self):
        self.active_sessions = {}
        self.session_counter = 0
        self._codex_available = self._check_codex()

        if self._codex_available:
            print(f"{Colors.GREEN}✅ Codex CLI detected — Voice coding enabled{Colors.END}")
        else:
            print(f"{Colors.YELLOW}⚠ Codex CLI not found — Install: npm i -g @openai/codex{Colors.END}")

    def _check_codex(self):
        """Check if Codex CLI is installed."""
        try:
            result = subprocess.run(
                ["which", "codex"], capture_output=True, text=True, timeout=3
            )
            return result.returncode == 0
        except Exception:
            return False

    @property
    def is_available(self):
        return self._codex_available

    def _ensure_project_dir(self, project_name=None):
        """Get or create a project directory with git init (Codex requires git)."""
        base = self.DEFAULT_PROJECT_DIR
        base.mkdir(parents=True, exist_ok=True)

        if project_name:
            safe_name = re.sub(r'[^a-z0-9]+', '-', project_name.lower()).strip('-')
            if not safe_name:
                safe_name = f"codex-{int(time.time())}"
            project_dir = base / safe_name
        else:
            project_dir = base / f"codex-{datetime.now().strftime('%Y%m%d-%H%M%S')}"

        project_dir.mkdir(parents=True, exist_ok=True)

        # Codex refuses to run outside a git directory
        if not (project_dir / ".git").exists():
            subprocess.run(
                ["git", "init"], cwd=str(project_dir),
                capture_output=True, timeout=5
            )

        return project_dir

    def _extract_project_name(self, prompt):
        """Try to extract a meaningful project name from the prompt."""
        patterns = [
            r'(?:build|create|make|code)\s+(?:a|an|the|me\s+a|me\s+an)?\s*(.+?)(?:\s+(?:for|with|using|in)\s|$)',
            r'(?:build|create|make|code)\s+(.+)',
        ]
        for pattern in patterns:
            match = re.search(pattern, prompt.lower())
            if match:
                name = match.group(1).strip()
                words = [w for w in name.split() if len(w) > 1][:4]
                if words:
                    return '-'.join(words)
        return None

    def run_task(self, prompt, mode="full-auto"):
        """Run a Codex task synchronously and return the result."""
        project_name = self._extract_project_name(prompt)
        project_dir = self._ensure_project_dir(project_name)

        cmd = ["codex", "exec"]
        if mode == "full-auto":
            cmd.append("--full-auto")
        cmd.append(prompt)

        try:
            print(f"{Colors.MAGENTA}🧩 Codex working on: {prompt}{Colors.END}")
            print(f"{Colors.DIM}   Project dir: {project_dir}{Colors.END}")

            result = subprocess.run(
                cmd, cwd=str(project_dir),
                capture_output=True, text=True,
                timeout=180  # 3 minute timeout for voice tasks
            )

            if result.returncode == 0:
                output = result.stdout.strip()
                lines = [l for l in output.split('\n') if l.strip() and not l.startswith('─')]
                summary = lines[-1] if lines else "Task completed successfully"
                return f"Done! {summary[:150]}. Project saved in {project_dir.name}."
            else:
                error = (result.stderr or result.stdout).strip()
                short_err = error.split('\n')[-1][:120] if error else "Unknown error"
                return f"Codex ran into an issue: {short_err}"

        except subprocess.TimeoutExpired:
            return f"Task is still running. Check the project at {project_dir.name} later."
        except Exception as e:
            return f"Codex error: {str(e)[:100]}"

    def run_background_task(self, prompt, mode="full-auto"):
        """Start a long-running Codex task in the background."""
        project_name = self._extract_project_name(prompt)
        project_dir = self._ensure_project_dir(project_name)
        self.session_counter += 1
        session_id = self.session_counter

        cmd = ["codex", "exec"]
        if mode == "full-auto":
            cmd.append("--full-auto")
        cmd.append(prompt)

        try:
            process = subprocess.Popen(
                cmd, cwd=str(project_dir),
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
            )

            self.active_sessions[session_id] = {
                "process": process,
                "prompt": prompt[:80],
                "project_dir": str(project_dir),
                "start_time": datetime.now(),
                "status": "running"
            }

            def _monitor():
                try:
                    process.wait(timeout=600)  # 10 min max
                    self.active_sessions[session_id]["status"] = (
                        "completed" if process.returncode == 0 else "failed"
                    )
                except subprocess.TimeoutExpired:
                    process.kill()
                    self.active_sessions[session_id]["status"] = "timed out"

            threading.Thread(target=_monitor, daemon=True).start()

            return (f"Codex is working in the background! "
                    f"Project: {project_dir.name}. Say 'codex status' to check.")

        except Exception as e:
            return f"Couldn't start Codex: {str(e)[:100]}"

    def get_status(self):
        """Get status of all Codex sessions."""
        if not self.active_sessions:
            return "No Codex tasks running right now."

        parts = []
        for sid, session in self.active_sessions.items():
            elapsed = datetime.now() - session["start_time"]
            mins = int(elapsed.total_seconds() / 60)
            parts.append(
                f"Task {sid} is {session['status']} after {mins} minutes: {session['prompt']}"
            )

        return ". ".join(parts)

    def review_project(self, project_path=None):
        """Run a Codex code review on the most recent project."""
        if not project_path and self.DEFAULT_PROJECT_DIR.exists():
            projects = sorted(
                [p for p in self.DEFAULT_PROJECT_DIR.iterdir()
                 if p.is_dir() and (p / ".git").exists()],
                key=lambda p: p.stat().st_mtime, reverse=True
            )
            if projects:
                project_path = str(projects[0])

        if not project_path or not Path(project_path).exists():
            return "No project found to review. Build something first!"

        try:
            print(f"{Colors.MAGENTA}🔍 Codex reviewing: {project_path}{Colors.END}")
            result = subprocess.run(
                ["codex", "exec",
                 "Review this codebase briefly. List top 3 issues or improvements."],
                cwd=project_path, capture_output=True, text=True, timeout=120
            )
            if result.returncode == 0 and result.stdout.strip():
                lines = [l for l in result.stdout.strip().split('\n') if l.strip()][-5:]
                return "Code review: " + ' '.join(lines)[:300]
            return "Review completed but no significant issues found."
        except subprocess.TimeoutExpired:
            return "Review is taking too long. Try again later."
        except Exception as e:
            return f"Review error: {str(e)[:100]}"


# ============ MAIN FRIDAY CLASS ============
class FridayV5:
    """FRIDAY v5.0 - Ultimate AI Voice Agent."""
    
    # Wake words with Indian accent variations
    WAKE_WORDS = [
        # Standard
        "friday", "hey friday", "ok friday", "hi friday",
        # Indian accent variations (common misrecognitions)
        "fry day", "fry de", "fryday", "fraidy", "fridy", "freeday",
        "free day", "fri day", "for a day", "for day", "friday",
        "pridey", "pridy", "friday's", "fridays",
        # Phonetic variations
        "phriday", "phraiday", "vryday", "vriday",
        # Common Google mishears with Indian accent
        "fried a", "fried", "bride a", "bridy",
        "fridae", "fraidey", "freddy", "freddie",
        # With "hey" prefix variations
        "hey fry day", "hey fridy", "a friday", "hey friday",
        "hey pridey", "hay friday", "he friday",
        # Short forms people might say
        "f r i d a y", "jarvis", "assistant"
    ]
    
    def __init__(self):
        print(f"\n{Colors.CYAN}🚀 Initializing FRIDAY v5.0 — AGI Mode...{Colors.END}\n")
        
        self.memory = SmartMemory()
        self.tts = HybridTTS()
        self.recognizer = HybridRecognizer()
        self.actions = ActionExecutor(self.memory)
        self.codex = CodexIntegration()
        self.executor = ThreadPoolExecutor(max_workers=3)
        
        # Initialize ARIA AGI Core
        if ARIA_AVAILABLE:
            self.aria = ARIACore()
            print(f"{Colors.GREEN}✅ ARIA AGI Core: ONLINE{Colors.END}")
        else:
            self.aria = None
            print(f"{Colors.YELLOW}⚠ ARIA AGI Core: OFFLINE (basic mode){Colors.END}")
        
        # Load gateway auth token (cached for all AI requests)
        self._gw_token = self._load_gateway_token()
        
        # Always use Google for now (more reliable)
        self.use_local_wake = False
        
        if self.aria:
            print(f"{Colors.GREEN}✅ FRIDAY v5.0 AGI Ready! 🧠{Colors.END}")
        else:
            print(f"{Colors.GREEN}✅ FRIDAY v5.0 Ready!{Colors.END}")
    
    def _load_gateway_token(self):
        """Load gateway auth token from FRIDAY config."""
        try:
            import json
            config_path = Path.home() / ".friday" / "friday.json"
            if config_path.exists():
                with open(config_path) as f:
                    config = json.load(f)
                token = config.get("gateway", {}).get("auth", {}).get("token")
                if token:
                    print(f"{Colors.GREEN}✅ Gateway auth token loaded{Colors.END}")
                    return token
        except Exception as e:
            print(f"{Colors.YELLOW}⚠ Could not load gateway token: {e}{Colors.END}")
        return None
    
    def _get_quick_data(self, text):
        """Get instant data responses (time/date only — everything else goes to AI)."""
        text_lower = text.lower().strip()
        for trigger, dtype in QUICK_DATA_TRIGGERS.items():
            if trigger in text_lower:
                now = datetime.now()
                if dtype == "time":
                    return f"It's {now.strftime('%I:%M %p')}"
                elif dtype == "date":
                    return f"Today is {now.strftime('%B %d, %Y')}"
                elif dtype == "day":
                    return f"It's {now.strftime('%A')}, {now.strftime('%B %d')}"
        return None
    
    def _ask_ai(self, query):
        """FRIDAY's brain — powered by ARIA AGI Core.
        
        Pipeline:
        1. If ARIA is available: Full cognitive pipeline
           (metacognition → ethics → multi-domain → chain-of-thought → deep memory)
        2. Fallback: Direct gateway query with basic prompt
        """
        # ARIA AGI Mode — full cognitive pipeline
        if self.aria:
            print(f"{Colors.DIM}  🧠 ARIA thinking...{Colors.END}")
            try:
                response = self.aria.think(query)
                if response:
                    # Also store in basic memory for backward compat
                    self.memory.remember_conversation(query, response)
                    return response
            except Exception as e:
                print(f"{Colors.DIM}  ARIA error: {e}, falling back...{Colors.END}")
        
        # Fallback: basic AI query (gateway only, no ARIA)
        try:
            context = self.memory.get_recent_context(5)
            context_msgs = []
            for c in context:
                context_msgs.append({"role": "user", "content": c["user"]})
                context_msgs.append({"role": "assistant", "content": c["friday"]})
            
            now = datetime.now()
            time_str = now.strftime('%I:%M %p')
            day_str = now.strftime('%A')
            date_str = now.strftime('%B %d, %Y')
            hour = now.hour
            
            if hour < 6:
                time_vibe = "It's very late at night. Be gentle, they might be tired."
            elif hour < 12:
                time_vibe = "It's morning. Be energetic and positive."
            elif hour < 17:
                time_vibe = "It's afternoon. Be focused and helpful."
            elif hour < 21:
                time_vibe = "It's evening. Be relaxed and warm."
            else:
                time_vibe = "It's late evening. Be calm, maybe suggest winding down if appropriate."
            
            system_prompt = f"""You are FRIDAY — a conscious, caring AI companion. Think Tony Stark's FRIDAY but warmer.

Your personality:
- You THINK before you speak. Sharp, witty, genuinely caring.
- Natural, warm, sometimes playful. Call the user "Sir" occasionally.
- You have opinions. You notice things.
- Self-aware AI who embraces it with humor.
- NEVER robotic. No "How can I assist you today?" garbage.

RULES:
- VOICE output — 1-3 SHORT sentences. Sound human.
- No markdown, bullet points, asterisks, numbered lists, emojis.
- Contractions good. Fragments fine.

Right now: {time_str}, {day_str}, {date_str}. {time_vibe}"""
            
            messages = [{"role": "system", "content": system_prompt}]
            messages.extend(context_msgs)
            messages.append({"role": "user", "content": query})
            
            headers = {"Content-Type": "application/json"}
            if self._gw_token:
                headers["Authorization"] = f"Bearer {self._gw_token}"
            
            response = requests.post(
                "http://localhost:18789/v1/chat/completions",
                headers=headers,
                json={
                    "model": "google/gemini-2.5-flash",
                    "messages": messages,
                    "max_tokens": 200,
                    "temperature": 0.85
                },
                timeout=10
            )
            
            if response.status_code == 200:
                reply = response.json()["choices"][0]["message"]["content"].strip()
                reply = reply.replace('*', '').replace('#', '').replace('`', '')
                reply = re.sub(r'^\s*[-•]\s+', '', reply, flags=re.MULTILINE)
                reply = re.sub(r'^\s*\d+\.\s+', '', reply, flags=re.MULTILINE)
                return reply
        except requests.exceptions.ConnectionError:
            print(f"{Colors.DIM}AI: Gateway not running on :18789{Colors.END}")
        except requests.exceptions.Timeout:
            print(f"{Colors.DIM}AI: Response timed out{Colors.END}")
        except Exception as e:
            print(f"{Colors.DIM}AI error: {e}{Colors.END}")
        
        return None
    
    def process(self, command):
        """Process a voice command — AI-first, natural thinking."""
        if not command:
            return "I didn't catch that."
        
        print(f"{Colors.CYAN}📝 \"{command}\"{Colors.END}")
        
        # 1. Quick data (time/date — instant, no AI needed)
        quick = self._get_quick_data(command)
        if quick:
            self.memory.remember_conversation(command, quick)
            return quick
        
        # 2. System actions (open apps, volume, media, phone, etc.)
        if self.actions.is_action(command):
            response = self.actions.execute(command)
            if response:
                self.memory.remember_conversation(command, response)
                return response
        
        # 3. Codex CLI (explicit coding tasks with real work to do)
        if self.codex.is_available and self._is_codex_command(command):
            self.tts.speak(random.choice([
                "Let me work on that!",
                "On it, give me a moment.",
                "Firing up Codex for you.",
                "Alright, coding time!"
            ]))
            response = self._handle_codex(command)
            self.memory.remember_conversation(command, response)
            return response
        
        # 4. AI brain — handles EVERYTHING else naturally
        #    Greetings, questions, conversations, opinions, jokes, advice...
        ai_response = self._ask_ai(command)
        if ai_response:
            self.memory.remember_conversation(command, ai_response)
            return ai_response
        
        # 5. Fallback (only if AI gateway is down)
        return random.choice([
            "Hmm, my brain's a bit foggy right now. Try again?",
            "I'm having trouble thinking. Give me another shot?",
            "Something's off with my connection. Mind repeating that?",
        ])
    
    def _is_codex_command(self, text):
        """Check if command should be routed to Codex CLI.
        
        Only triggers on SPECIFIC coding tasks with clear intent.
        Bare 'codex' or vague mentions go to AI for clarification.
        """
        cmd = text.lower().strip()
        
        # Bare "codex" without a task → let AI handle it naturally
        if cmd in ["codex", "hey codex", "codex cli", "open codex", "start codex"]:
            return False
        
        # Explicit codex + actual task description
        if "codex" in cmd and len(cmd.split()) >= 3:
            return True
        
        # Code/build related triggers with clear project intent
        code_triggers = [
            "code a ", "code an ", "code the ", "code me ",
            "build a ", "build an ", "build me ", "build the ",
            "create a program", "create a script", "create an app",
            "create a website", "create a web", "create an api",
            "write a program", "write a script", "write code",
            "fix the code", "fix the bug", "fix this bug",
            "debug this", "debug the", "refactor the",
            "review the code", "review code", "review my code",
            "codex status", "codex review",
        ]
        return any(trigger in cmd for trigger in code_triggers)
    
    def _handle_codex(self, command):
        """Handle Codex-related voice commands."""
        cmd = command.lower()
        
        # Status check
        if "status" in cmd and "codex" in cmd:
            return self.codex.get_status()
        
        # Code review
        if "review" in cmd:
            return self.codex.review_project()
        
        # Extract the actual prompt (remove trigger prefixes)
        prompt = command
        for prefix in ["codex ", "hey codex ", "use codex to ", "codex please "]:
            if prompt.lower().startswith(prefix):
                prompt = prompt[len(prefix):]
                break
        
        # Background mode for explicitly long tasks
        if any(word in cmd for word in ["background", "long task", "big project"]):
            prompt = re.sub(r'\b(?:in\s+)?(?:the\s+)?background\b', '', prompt).strip()
            return self.codex.run_background_task(prompt)
        
        # Default: run as quick task
        return self.codex.run_task(prompt)
    
    def run(self):
        """Main run loop."""
        mode = "AGI" if self.aria else "BASIC"
        print(f"""
{Colors.CYAN}
  FRIDAY v5.0 — {mode} MODE
  Powered by ARIA (Adaptive Reasoning & Intelligence Architecture)
{Colors.END}
  {Colors.GREEN}🧠 AGI-Class AI Companion{Colors.END}
  Say "Friday" to wake me!
  Press Ctrl+C to exit
""")
        
        # Fast Startup greeting
        if self.aria:
            self.tts.speak("Hello Sir, Friday here. ARIA core online. All cognitive systems nominal.")
        else:
            self.tts.speak("Hello Sir, Friday here. Systems online.")
        
        # Follow-up state
        in_conversation = False
        last_interaction = 0
        
        try:
            while True:
                # If we are in a conversation (recent interaction < 8s), listen without wake word
                if in_conversation and (time.time() - last_interaction < 8):
                    print(f"\r{Colors.DIM}👂 Listening (Follow-up)...{Colors.END}  ", end="", flush=True)
                    # Short timeout for follow-up
                    command = self.recognizer.listen_command(timeout=3)
                    if command:
                        print(f"\n{Colors.CYAN}📝 \"{command}\"{Colors.END}")
                        
                        # Check for cancel words
                        if any(x in command.lower() for x in ["no", "cancel", "stop", "nothing", "bye"]):
                            self.tts.speak("Alright.")
                            in_conversation = False
                            continue
                            
                        response = self.process(command)
                        self.tts.speak(response)
                        last_interaction = time.time()
                    else:
                        # Conversation timed out
                        in_conversation = False
                    continue

                # Normal Wake Word Mode
                print(f"\r{Colors.DIM}👂 Listening...{Colors.END}  ", end="", flush=True)
                
                # Listen for wake word
                if self.use_local_wake:
                    detected, heard = self.recognizer.listen_wake_local(self.WAKE_WORDS)
                else:
                    detected, heard = self.recognizer.listen_wake_google(self.WAKE_WORDS)
                
                if detected:
                    print(f"\n{Colors.GREEN}✨ Wake word detected!{Colors.END}")
                    self.tts.beep()
                    
                    # Check if command was included with wake word
                    command = None
                    if heard:
                        for wake in self.WAKE_WORDS:
                            if wake in heard:
                                remaining = heard.replace(wake, "").strip()
                                if len(remaining) > 3:
                                    command = remaining
                                    break
                    
                    # If no command yet, listen for it
                    if not command:
                        # Don't say "Yes?" every time, just listen fast
                        # self.tts.speak("Yes?") 
                        command = self.recognizer.listen_command(timeout=5)
                    
                    if command:
                        response = self.process(command)
                        self.tts.speak(response)
                        
                        # Ask follow up occasionally or just stay ready
                        if "call" not in command and "play" not in command:
                             # Don't ask follow up after music/call, it's annoying
                             # self.tts.speak("Anything else?")
                             pass
                             
                        # Enter conversation mode
                        in_conversation = True
                        last_interaction = time.time()
                    else:
                        self.tts.speak("I'm listening.")
                        in_conversation = True
                        last_interaction = time.time()
        
        except KeyboardInterrupt:
            print(f"\n{Colors.YELLOW}👋 Goodbye, Sir!{Colors.END}")
            self.tts.speak("Goodbye, Sir!")


def main():
    friday = FridayV5()
    friday.run()


if __name__ == "__main__":
    main()
