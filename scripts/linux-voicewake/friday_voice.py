#!/usr/bin/env python3
"""
🤖 F.R.I.D.A.Y Voice Wake for Linux
=====================================
Always-on voice assistant with wake word detection.
Uses Microsoft Edge TTS for natural voice (free, no API key needed).

Wake words: "Friday", "Hey Friday"
"""

import argparse
import json
import os
import sys
import subprocess
import re
import tempfile
import asyncio
import time
from pathlib import Path

try:
    import requests
except ImportError:
    print("❌ Missing 'requests'. Install with: pip install requests")
    sys.exit(1)

try:
    import speech_recognition as sr
except ImportError:
    print("❌ Missing 'speech_recognition'. Install with: pip install SpeechRecognition")
    sys.exit(1)

try:
    import edge_tts
except ImportError:
    print("❌ Missing 'edge_tts'. Install with: pip install edge-tts")
    sys.exit(1)

os.environ['PYTHONWARNINGS'] = 'ignore'

# ANSI colors
class Colors:
    CYAN = '\033[96m'
    GREEN = '\033[92m'
    YELLOW = '\033[93m'
    RED = '\033[91m'
    MAGENTA = '\033[95m'
    BOLD = '\033[1m'
    END = '\033[0m'

def print_banner():
    banner = f"""{Colors.CYAN}{Colors.BOLD}
███████╗██████╗ ██╗██████╗  █████╗ ██╗   ██╗
██╔════╝██╔══██╗██║██╔══██╗██╔══██╗╚██╗ ██╔╝
█████╗  ██████╔╝██║██║  ██║███████║ ╚████╔╝ 
██╔══╝  ██╔══██╗██║██║  ██║██╔══██║  ╚██╔╝  
██║     ██║  ██║██║██████╔╝██║  ██║   ██║   
╚═╝     ╚═╝  ╚═╝╚═╝╚═════╝ ╚═╝  ╚═╝   ╚═╝   
{Colors.END}
{Colors.MAGENTA}        🤖 Voice Wake for Linux 🤖{Colors.END}
{Colors.GREEN}        Say "Friday" to wake me up!{Colors.END}
"""
    print(banner)


class EdgeTTS:
    """Microsoft Edge TTS - Free, natural-sounding voice."""
    
    # Natural female voices (choose one):
    # en-US-JennyNeural - Young, friendly female
    # en-US-AriaNeural - Professional female
    # en-GB-SoniaNeural - British female
    # en-IN-NeerjaNeural - Indian English female
    
    DEFAULT_VOICE = "en-GB-SoniaNeural"  # British female - F.R.I.D.A.Y's voice
    
    def __init__(self, voice=None):
        self.voice = voice or self.DEFAULT_VOICE
        
    async def _generate_speech(self, text, output_path):
        """Generate speech using Edge TTS."""
        communicate = edge_tts.Communicate(text, self.voice)
        await communicate.save(output_path)
        
    def speak(self, text):
        """Convert text to speech and play it."""
        if not text:
            return
            
        # Clean text
        text = re.sub(r'\[\[.*?\]\]', '', text)
        text = text.replace("*", "").replace("#", "").replace("`", "").replace("_", "")
        text = text.strip()
        
        # Limit to ~300 chars for quick response (about 20-25 seconds of speech)
        if len(text) > 300:
            # Find a good break point
            text = text[:300]
            # Try to end at sentence
            last_period = text.rfind('.')
            if last_period > 150:
                text = text[:last_period + 1]
            text += " That's the short version."
        
        try:
            # Create temp file
            with tempfile.NamedTemporaryFile(suffix='.mp3', delete=False) as f:
                audio_path = f.name
            
            # Generate speech
            asyncio.run(self._generate_speech(text, audio_path))
            
            # Play audio
            self._play_audio(audio_path)
            
            # Cleanup
            os.unlink(audio_path)
            return True
            
        except Exception as e:
            print(f"{Colors.RED}TTS error: {e}{Colors.END}")
            return False
    
    def _play_audio(self, path):
        """Play audio file using available player."""
        players = [
            ["mpv", "--no-video", "--really-quiet", path],
            ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", path],
            ["mpg123", "-q", path],
            ["aplay", path],
        ]
        
        for cmd in players:
            try:
                subprocess.run(cmd, capture_output=True, timeout=60)
                return
            except (FileNotFoundError, subprocess.TimeoutExpired):
                continue


class GeminiAPI:
    """Direct Gemini API for fast responses."""
    
    SYSTEM_PROMPT = """You are FRIDAY, a helpful AI assistant. Keep responses SHORT and CONCISE (under 100 words).
You are speaking out loud, so be conversational and natural. Don't use markdown formatting.
If asked about time, respond with the current time naturally."""
    
    def __init__(self, api_key):
        self.api_key = api_key
        self.base_url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent"
        
    def ask(self, message):
        """Send a quick question to Gemini and get response."""
        try:
            url = f"{self.base_url}?key={self.api_key}"
            
            # Add current time context
            current_time = time.strftime("%I:%M %p")
            current_date = time.strftime("%A, %B %d, %Y")
            
            full_prompt = f"{self.SYSTEM_PROMPT}\n\nCurrent time: {current_time}\nCurrent date: {current_date}\n\nUser: {message}"
            
            payload = {
                "contents": [{"parts": [{"text": full_prompt}]}],
                "generationConfig": {
                    "temperature": 0.7,
                    "maxOutputTokens": 150,  # Short responses
                    "topP": 0.9
                }
            }
            
            response = requests.post(url, json=payload, timeout=15)
            
            if response.status_code == 200:
                data = response.json()
                text = data.get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text", "")
                return text.strip()
            else:
                return None
                
        except Exception as e:
            print(f"{Colors.RED}API Error: {e}{Colors.END}")
            return None


class FridayVoiceAssistant:
    def __init__(self, wake_words=None, friday_path=None, phone_number=None, 
                 tts_enabled=True, voice=None, fast_mode=True):
        self.wake_words = wake_words or ["friday", "hey friday", "ok friday"]
        self.friday_path = friday_path or self._find_friday_path()
        self.phone_number = phone_number or self._get_phone_number()
        self.tts_enabled = tts_enabled
        self.fast_mode = fast_mode
        
        # Load Gemini API key for fast mode
        self.gemini_api = None
        if fast_mode:
            api_key = self._get_gemini_key()
            if api_key:
                self.gemini_api = GeminiAPI(api_key)
                print(f"{Colors.GREEN}⚡ Fast mode enabled (direct Gemini API){Colors.END}")
            else:
                print(f"{Colors.YELLOW}⚠ Fast mode unavailable (no API key), using CLI{Colors.END}")
                self.fast_mode = False
        
        # Edge TTS for natural voice
        self.tts = EdgeTTS(voice) if tts_enabled else None
        
        # Speech recognizer
        self.recognizer = sr.Recognizer()
        self.microphone = sr.Microphone()
        
        # Balanced speed and accuracy
        self.recognizer.energy_threshold = 3000  # Sensitive to speech
        self.recognizer.dynamic_energy_threshold = True
        self.recognizer.pause_threshold = 0.8  # Wait for natural pause (0.8s silence = end of phrase)
        self.recognizer.phrase_threshold = 0.3  # Phrase detection
        self.recognizer.non_speaking_duration = 0.5  # Wait for speech to start
        
        print(f"{Colors.YELLOW}🎤 Calibrating microphone...{Colors.END}")
        with self.microphone as source:
            self.recognizer.adjust_for_ambient_noise(source, duration=1)
        print(f"{Colors.GREEN}✓ Microphone ready!{Colors.END}")
    
    def _find_friday_path(self):
        paths = [
            Path(__file__).parent.parent.parent,
            Path.home() / "friday",
            Path("/media/balaraj/New Volume/projects/F.R.I.D.A.Y/F.R.I.D.A.Y"),
        ]
        for p in paths:
            if (p / "package.json").exists():
                return str(p)
        return str(paths[0])
    
    def _get_phone_number(self):
        config_path = Path.home() / ".friday" / "friday.json"
        try:
            with open(config_path) as f:
                config = json.load(f)
                allow_from = config.get("channels", {}).get("whatsapp", {}).get("allowFrom", [])
                if allow_from:
                    return allow_from[0]
        except:
            pass
        return "+918431206594"
    
    def _get_gemini_key(self):
        """Get Gemini API key from config or environment."""
        # Try environment first
        if os.environ.get('GEMINI_API_KEY'):
            return os.environ['GEMINI_API_KEY']
        
        # Try friday config
        config_path = Path.home() / ".friday" / "friday.json"
        try:
            with open(config_path) as f:
                config = json.load(f)
                
                # Try skills.entries (where Gemini API keys are stored)
                skills = config.get("skills", {}).get("entries", {})
                # Look for any Google AI key
                for skill in ["nano-banana-pro", "goplaces", "local-places"]:
                    key = skills.get(skill, {}).get("apiKey")
                    if key and key.startswith("AIza"):  # Google AI key pattern
                        return key
                
                # Try providers.google.apiKey
                google_key = config.get("providers", {}).get("google", {}).get("apiKey")
                if google_key:
                    return google_key
        except:
            pass
        
        return None
        
    def speak(self, text):
        if not self.tts_enabled or not text or not self.tts:
            return
        
        print(f"{Colors.MAGENTA}🔊 Speaking...{Colors.END}")
        self.tts.speak(text)
    
    def send_to_friday(self, message):
        """Send message - uses fast Gemini API or CLI fallback."""
        print(f"{Colors.CYAN}🤖 Thinking...{Colors.END}")
        
        # FAST MODE: Direct Gemini API (much faster!)
        if self.fast_mode and self.gemini_api:
            response = self.gemini_api.ask(message)
            if response:
                display = response[:300] + "..." if len(response) > 300 else response
                print(f"\n{Colors.GREEN}F.R.I.D.A.Y:{Colors.END} {display}\n")
                return response
            # Fall through to CLI if API fails
        
        # CLI FALLBACK: Full F.R.I.D.A.Y agent (slower but more capable)
        try:
            cmd = [
                "node", "scripts/run-node.mjs", "agent",
                "--message", message,
                "--to", self.phone_number
            ]
            
            result = subprocess.run(
                cmd,
                cwd=self.friday_path,
                capture_output=True,
                text=True,
                timeout=60
            )
            
            output = result.stdout.strip()
            
            # Extract response after warnings
            lines = output.split('\n')
            response_lines = []
            skip_header = True
            
            for line in lines:
                if 'friday@' in line or '> node' in line:
                    continue
                if '◇' in line or '│' in line or '├' in line or '╮' in line or '╯' in line:
                    skip_header = True
                    continue
                if skip_header and line.strip():
                    skip_header = False
                if not skip_header and line.strip():
                    response_lines.append(line.strip())
            
            if response_lines:
                response = '\n'.join(response_lines)
                response = re.sub(r'\[\[tts:[^\]]*\]\]', '', response).strip()
                
                if response:
                    display = response[:300] + "..." if len(response) > 300 else response
                    print(f"\n{Colors.GREEN}F.R.I.D.A.Y:{Colors.END} {display}\n")
                    return response
            
            return None
                
        except subprocess.TimeoutExpired:
            return "Sorry, request timed out."
        except Exception as e:
            print(f"{Colors.RED}Error: {e}{Colors.END}")
            return None
    
    def listen_for_wake_word(self):
        print(f"\r{Colors.CYAN}👂 Listening...{Colors.END}", end="", flush=True)
        
        with self.microphone as source:
            try:
                audio = self.recognizer.listen(source, timeout=None, phrase_time_limit=3)
                
                try:
                    text = self.recognizer.recognize_google(audio).lower()
                    print(f"\n{Colors.YELLOW}   Heard: '{text}'{Colors.END}")
                    
                    for wake_word in self.wake_words:
                        if wake_word in text:
                            return True, text
                    
                except sr.UnknownValueError:
                    pass
                except sr.RequestError:
                    print(f"\n{Colors.RED}❌ Speech error{Colors.END}")
                    
            except sr.WaitTimeoutError:
                pass
        
        return False, None
    
    def listen_for_command(self):
        # Say "Yes sir?" first
        self.speak("Yes sir?")
        
        # Then start listening
        print(f"{Colors.GREEN}🎤 Listening...{Colors.END}")
        
        with self.microphone as source:
            try:
                # timeout=6: wait 6s for speech to start
                # phrase_time_limit=15: allow up to 15s of speaking
                audio = self.recognizer.listen(source, timeout=6, phrase_time_limit=15)
                
                try:
                    text = self.recognizer.recognize_google(audio)
                    print(f"{Colors.CYAN}📝 '{text}'{Colors.END}")
                    return text
                except sr.UnknownValueError:
                    print(f"{Colors.YELLOW}🤔 Didn't catch that{Colors.END}")
                    self.speak("I didn't catch that.")
                except sr.RequestError:
                    pass
            except sr.WaitTimeoutError:
                print(f"{Colors.YELLOW}⏰ No command heard{Colors.END}")
        
        return None
    
    def listen_for_followup(self):
        """Listen for follow-up command (no wake word needed)."""
        print(f"{Colors.CYAN}   (Say command or 'that's all' to exit){Colors.END}")
        
        with self.microphone as source:
            try:
                # Allow longer phrases for follow-ups
                audio = self.recognizer.listen(source, timeout=8, phrase_time_limit=15)
                
                try:
                    text = self.recognizer.recognize_google(audio).lower()
                    print(f"{Colors.GREEN}📝 Follow-up: '{text}'{Colors.END}")
                    
                    # Check for exit phrases - only if it's the entire command
                    exit_exact = ["that's all", "thank you", "thanks", "goodbye", 
                                  "bye", "go to sleep", "nevermind", "never mind",
                                  "no", "nothing", "nope", "stop listening"]
                    if text.strip() in exit_exact or text.strip() == "stop":
                        print(f"{Colors.YELLOW}   (Exiting conversation mode){Colors.END}")
                        return None, True  # Exit conversation mode
                    
                    return text, False  # Got a command
                    
                except sr.UnknownValueError:
                    print(f"{Colors.YELLOW}   (Didn't catch that, trying again...){Colors.END}")
                    return None, False  # Didn't hear, ask again
                except sr.RequestError as e:
                    print(f"{Colors.RED}   Speech error: {e}{Colors.END}")
                    return None, True  # Error, exit conversation
                    
            except sr.WaitTimeoutError:
                print(f"{Colors.YELLOW}   (Timeout - exiting conversation){Colors.END}")
                return None, True  # Timeout, exit conversation
        
        return None, True
    
    def run(self):
        print_banner()
        
        print(f"{Colors.GREEN}🚀 F.R.I.D.A.Y Voice Wake Active!{Colors.END}")
        print(f"{Colors.YELLOW}   Wake words: {', '.join(self.wake_words)}{Colors.END}")
        print(f"{Colors.YELLOW}   Voice: ✅ Microsoft Edge Neural TTS{Colors.END}")
        print(f"{Colors.YELLOW}   Mode: 💬 Conversation (follow-ups without wake word){Colors.END}")
        print(f"\n{Colors.CYAN}Press Ctrl+C to stop.{Colors.END}\n")
        
        self.speak("Friday online. Say my name when you need me.")
        
        try:
            while True:
                detected, heard_text = self.listen_for_wake_word()
                
                if detected:
                    print(f"\n{Colors.BOLD}{Colors.GREEN}✨ Wake word!{Colors.END}")
                    
                    # Check if command was in wake phrase
                    command = None
                    for wake_word in self.wake_words:
                        if heard_text and wake_word in heard_text:
                            idx = heard_text.find(wake_word)
                            remaining = heard_text[idx + len(wake_word):].strip()
                            if remaining and len(remaining) > 3:
                                command = remaining
                                print(f"{Colors.CYAN}📝 Command in phrase: '{command}'{Colors.END}")
                                break
                    
                    if not command:
                        command = self.listen_for_command()
                    
                    # Process command and enter conversation mode
                    if command:
                        response = self.send_to_friday(command)
                        if response:
                            self.speak(response)
                        
                        # CONVERSATION MODE: Keep listening for follow-ups
                        max_retries = 2
                        retry_count = 0
                        in_conversation = True
                        
                        while in_conversation:
                            self.speak("Anything else?")
                            followup, should_exit = self.listen_for_followup()
                            
                            if should_exit:
                                # User wants to exit
                                in_conversation = False
                                self.speak("Alright. Just say my name if you need me.")
                            elif followup:
                                # Got a follow-up command - process it!
                                retry_count = 0  # Reset retries
                                print(f"{Colors.CYAN}🤖 Processing follow-up...{Colors.END}")
                                response = self.send_to_friday(followup)
                                if response:
                                    self.speak(response)
                            else:
                                # Didn't hear anything
                                retry_count += 1
                                if retry_count >= max_retries:
                                    in_conversation = False
                                    self.speak("I'll be here when you need me.")
                    
                    print()
                    
        except KeyboardInterrupt:
            print(f"\n\n{Colors.YELLOW}👋 Goodbye!{Colors.END}")
            self.speak("Goodbye!")
            sys.exit(0)


def main():
    parser = argparse.ArgumentParser(description="🤖 F.R.I.D.A.Y Voice Wake")
    parser.add_argument("--wake-word", "-w", action="append", dest="wake_words")
    parser.add_argument("--friday-path", "-p")
    parser.add_argument("--phone")
    parser.add_argument("--no-tts", action="store_true")
    parser.add_argument("--voice", "-v", default="en-US-JennyNeural",
                        help="Edge TTS voice (e.g., en-US-JennyNeural, en-GB-SoniaNeural)")
    
    args = parser.parse_args()
    
    assistant = FridayVoiceAssistant(
        wake_words=args.wake_words or ["friday", "hey friday", "ok friday"],
        friday_path=args.friday_path,
        phone_number=args.phone,
        tts_enabled=not args.no_tts,
        voice=args.voice
    )
    
    assistant.run()


if __name__ == "__main__":
    main()
