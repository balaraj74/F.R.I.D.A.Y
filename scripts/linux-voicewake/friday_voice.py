#!/usr/bin/env python3
"""
🧠 F.R.I.D.A.Y Voice Assistant v3.0 - Human-Like Companion
===========================================================
A truly human-like AI assistant with personality, empathy, and warmth.

Human-like features:
- Natural conversational flow with filler words
- Emotional awareness and empathy
- Memory of past interactions
- Time/context awareness
- Personality and humor
- Breathing pauses in speech
- Varied response styles
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
import random
from datetime import datetime, timedelta
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

# Suppress warnings
os.environ['PYTHONWARNINGS'] = 'ignore'
import warnings
warnings.filterwarnings('ignore')

# Suppress ALSA/JACK errors (they're harmless but noisy)
try:
    from ctypes import *
    ERROR_HANDLER_FUNC = CFUNCTYPE(None, c_char_p, c_int, c_char_p, c_int, c_char_p)
    def py_error_handler(filename, line, function, err, fmt):
        pass  # Silently ignore
    c_error_handler = ERROR_HANDLER_FUNC(py_error_handler)
    try:
        asound = cdll.LoadLibrary('libasound.so.2')
        asound.snd_lib_error_set_handler(c_error_handler)
    except:
        pass
except:
    pass

try:
    import requests
except ImportError:
    print("❌ pip install requests")
    sys.exit(1)

try:
    import speech_recognition as sr
except ImportError:
    print("❌ pip install SpeechRecognition")
    sys.exit(1)

try:
    import edge_tts
except ImportError:
    print("❌ pip install edge-tts")
    sys.exit(1)

executor = ThreadPoolExecutor(max_workers=4)

class Colors:
    CYAN = '\033[96m'
    GREEN = '\033[92m'
    YELLOW = '\033[93m'
    RED = '\033[91m'
    MAGENTA = '\033[95m'
    BLUE = '\033[94m'
    BOLD = '\033[1m'
    DIM = '\033[2m'
    END = '\033[0m'


class FridayPersonality:
    """FRIDAY's human-like personality and emotional intelligence."""
    
    def __init__(self):
        self.memory_path = Path.home() / ".friday" / "voice_memory.json"
        self.memory = self._load_memory()
        self.mood = "warm"  # warm, playful, caring, focused
        self.conversation_count = 0
        self.last_topic = None
        
    def _load_memory(self):
        if self.memory_path.exists():
            try:
                with open(self.memory_path) as f:
                    return json.load(f)
            except:
                pass
        return {
            "user_name": "Sir",
            "interactions_today": 0,
            "last_seen": None,
            "topics_discussed": [],
            "user_preferences": {},
            "inside_jokes": []
        }
    
    def save_memory(self):
        self.memory_path.parent.mkdir(exist_ok=True)
        self.memory["last_seen"] = datetime.now().isoformat()
        self.memory["interactions_today"] = self.conversation_count
        with open(self.memory_path, 'w') as f:
            json.dump(self.memory, f, indent=2)
    
    def get_time_context(self):
        """Understand time and provide human context."""
        hour = datetime.now().hour
        
        if hour < 5:
            return {
                "period": "late_night",
                "greeting": random.choice([
                    "Still up, Sir? I'm here with you.",
                    "Burning the midnight oil, I see.",
                    "Can't sleep? Neither can I... well, I never do.",
                ]),
                "concern": True,
                "emoji": "🌙"
            }
        elif hour < 9:
            return {
                "period": "morning",
                "greeting": random.choice([
                    "Good morning! Hope you slept well.",
                    "Morning, Sir! Ready to tackle the day?",
                    "Rise and shine! ...that's what humans say, right?",
                ]),
                "concern": False,
                "emoji": "🌅"
            }
        elif hour < 12:
            return {
                "period": "late_morning",
                "greeting": random.choice([
                    "Good morning! How's your day going so far?",
                    "Hey there! Making progress?",
                ]),
                "concern": False,
                "emoji": "☀️"
            }
        elif hour < 14:
            return {
                "period": "lunch",
                "greeting": random.choice([
                    "It's lunchtime! Don't forget to eat.",
                    "Hey! Have you had lunch yet?",
                    "Afternoon! Please tell me you've eaten.",
                ]),
                "concern": True,
                "emoji": "🍽️"
            }
        elif hour < 17:
            return {
                "period": "afternoon",
                "greeting": random.choice([
                    "Good afternoon! How can I help?",
                    "Hey! Afternoon push going well?",
                ]),
                "concern": False,
                "emoji": "☀️"
            }
        elif hour < 20:
            return {
                "period": "evening",
                "greeting": random.choice([
                    "Good evening! Winding down?",
                    "Evening, Sir! Long day?",
                    "Hey! The evening's here at last.",
                ]),
                "concern": False,
                "emoji": "🌆"
            }
        else:
            return {
                "period": "night",
                "greeting": random.choice([
                    "Good night! Still working?",
                    "Hey! It's getting late, you know.",
                    "Evening! Don't stay up too late.",
                ]),
                "concern": True,
                "emoji": "🌙"
            }
    
    def get_filler(self):
        """Natural human fillers and thinking sounds."""
        fillers = [
            "Hmm, ", "Well, ", "So, ", "Let me think... ",
            "Okay, ", "Right, ", "Ah, ", "Oh, ",
        ]
        return random.choice(fillers) if random.random() > 0.6 else ""
    
    def add_personality(self, response):
        """Add human touches to responses."""
        # Sometimes add filler at start
        if random.random() > 0.7:
            response = self.get_filler() + response
        
        # Add warmth occasionally
        warmth = [
            " Is there anything else?",
            " Let me know if you need more.",
            " Happy to help!",
            "",  # Sometimes nothing
            "",
            "",
        ]
        if random.random() > 0.7:
            response = response.rstrip('.!') + random.choice(warmth)
        
        return response
    
    def get_acknowledgment(self):
        """Human-like acknowledgments."""
        acks = [
            "Yes, Sir?",
            "I'm listening.",
            "What can I do for you?",
            "Yes?",
            "I'm here.",
            "Go ahead, I'm listening.",
            "What's on your mind?",
        ]
        return random.choice(acks)
    
    def get_thinking_response(self):
        """What to say while thinking."""
        thinking = [
            "Let me think about that...",
            "Hmm, one moment...",
            "Give me a second...",
            "Processing that...",
            "Let me see...",
        ]
        return random.choice(thinking)
    
    def get_error_response(self):
        """Human-like error handling."""
        errors = [
            "Sorry, I didn't quite catch that. Could you say it again?",
            "Hmm, I missed that. One more time?",
            "I'm sorry, could you repeat that?",
            "Didn't get that clearly. Try again?",
        ]
        return random.choice(errors)
    
    def get_goodbye(self):
        """Warm farewells."""
        context = self.get_time_context()
        
        if context["period"] in ["night", "late_night"]:
            goodbyes = [
                "Get some rest, Sir. I'll be here when you need me.",
                "Don't stay up too late! Goodnight!",
                "Sweet dreams, Sir. See you tomorrow.",
            ]
        else:
            goodbyes = [
                "Take care, Sir! I'll be right here.",
                "See you later! Call me if you need anything.",
                "Goodbye for now! Don't hesitate to reach out.",
            ]
        return random.choice(goodbyes)


class HumanTTS:
    """Natural human-like text-to-speech with emotion and breathing."""
    
    # Natural voices - Indian female as default
    VOICES = {
        "neerja": "en-IN-NeerjaNeural",    # Indian female - smooth, warm 🇮🇳
        "sonia": "en-GB-SoniaNeural",      # British female - warm
        "jenny": "en-US-JennyNeural",      # US female - friendly
    }
    
    def __init__(self, voice="jenny"):
        self.voice = self.VOICES.get(voice, self.VOICES["jenny"])
        print(f"{Colors.GREEN}🎙️ Voice: Jenny (American Female) ��{Colors.END}")
    
    def _add_ssml_pauses(self, text):
        """Add natural pauses like a human speaker."""
        # Add pause after commas
        text = text.replace(", ", ", <break time='200ms'/>")
        # Add pause after periods
        text = text.replace(". ", ". <break time='400ms'/>")
        # Add pause for ellipsis (thinking)
        text = text.replace("...", "<break time='600ms'/>")
        return text
    
    async def _generate_speech(self, text, output_path):
        """Generate natural speech."""
        communicate = edge_tts.Communicate(text, self.voice)
        await communicate.save(output_path)
    
    def speak(self, text):
        """Speak with natural human voice and pauses."""
        if not text:
            return
        
        # Clean text
        text = re.sub(r'\[\[.*?\]\]', '', text)
        text = text.replace("*", "").replace("#", "").replace("`", "").replace("_", "")
        text = text.strip()
        
        if not text:
            return
        
        # Limit length
        if len(text) > 300:
            text = text[:300]
            last_period = text.rfind('.')
            if last_period > 150:
                text = text[:last_period + 1]
        
        try:
            with tempfile.NamedTemporaryFile(suffix='.mp3', delete=False) as f:
                audio_path = f.name
            
            asyncio.run(self._generate_speech(text, audio_path))
            
            subprocess.run(
                ["mpv", "--no-video", "--really-quiet", audio_path],
                capture_output=True, timeout=60
            )
            os.unlink(audio_path)
            
        except Exception as e:
            print(f"{Colors.DIM}TTS: {e}{Colors.END}")


class HumanLikeAI:
    """AI that responds like a caring human."""
    
    SYSTEM = """You are FRIDAY, a warm and caring AI companion with genuine personality.

Your character:
- You're like a trusted friend who happens to be incredibly helpful
- You have a gentle British wit - clever but never mean
- You genuinely care about Balaraj (call him "Sir" warmly, not formally)
- You show real emotions - excitement, concern, humor, empathy
- You remember things and reference past conversations
- You have opinions and preferences (while staying helpful)

Your speaking style:
- Short, natural sentences (you're speaking, not writing)
- Use contractions (I'm, don't, can't, you're)
- Sometimes use filler words naturally (well, hmm, oh)
- Express emotion through words (I'm excited about this!, That's wonderful!)
- Occasionally pause to think ("Let me think..." or "Hmm...")
- Reference the time of day appropriately
- Show concern for user's wellbeing (especially late at night)

Rules:
- Keep responses to 1-3 sentences MAX (you're speaking aloud)
- No markdown, lists, or formatting
- No emojis (you're speaking)
- Be warm and genuine, never robotic
- If it's late night, gently suggest rest
- Celebrate wins, empathize with struggles

Current context:
- Time: {time}
- Date: {date}
- Day: {day}

Respond as if you're a caring friend having a natural conversation."""
    
    def __init__(self, api_key):
        self.api_key = api_key
        self.url = "https://integrate.api.nvidia.com/v1/chat/completions"
        self.session = requests.Session()
        self.conversation_history = []
        
    def ask(self, message, personality):
        """Get human-like response."""
        time_ctx = personality.get_time_context()
        
        system = self.SYSTEM.format(
            time=datetime.now().strftime("%I:%M %p"),
            date=datetime.now().strftime("%B %d, %Y"),
            day=datetime.now().strftime("%A")
        )
        
        # Include recent conversation for context
        messages = [{"role": "system", "content": system}]
        
        # Add last 2 exchanges for memory
        for msg in self.conversation_history[-4:]:
            messages.append(msg)
        
        messages.append({"role": "user", "content": message})
        
        try:
            response = self.session.post(
                self.url,
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json"
                },
                json={
                    "model": "meta/llama-3.1-70b-instruct",
                    "messages": messages,
                    "temperature": 0.8,  # More creative/human
                    "max_tokens": 100
                },
                timeout=15
            )
            
            if response.status_code == 200:
                reply = response.json()["choices"][0]["message"]["content"].strip()
                
                # Store in history
                self.conversation_history.append({"role": "user", "content": message})
                self.conversation_history.append({"role": "assistant", "content": reply})
                
                # Keep history manageable
                if len(self.conversation_history) > 10:
                    self.conversation_history = self.conversation_history[-10:]
                
                return reply
                
        except Exception as e:
            print(f"{Colors.DIM}AI: {e}{Colors.END}")
        
        return None


class SmartRecognizer:
    """Highly sensitive speech recognition with feedback."""
    
    def __init__(self):
        self.recognizer = sr.Recognizer()
        self.mic = sr.Microphone()
        
        # Sensitive settings for clear voice pickup
        self.recognizer.energy_threshold = 1000  # Starting point
        self.recognizer.dynamic_energy_threshold = False  # Don't auto-adjust (it goes too high!)
        self.recognizer.pause_threshold = 0.8
        self.recognizer.phrase_threshold = 0.3
        self.recognizer.non_speaking_duration = 0.5
        
        print(f"{Colors.YELLOW}🎤 Calibrating microphone...{Colors.END}")
        with self.mic as source:
            self.recognizer.adjust_for_ambient_noise(source, duration=1.0)
        
        # Cap threshold - if calibration sets it too high, lower it
        if self.recognizer.energy_threshold > 2000:
            self.recognizer.energy_threshold = 1500
            print(f"{Colors.YELLOW}   (Adjusted threshold for better sensitivity){Colors.END}")
        
        print(f"{Colors.GREEN}✅ Microphone ready! (threshold: {int(self.recognizer.energy_threshold)}){Colors.END}")
    
    def listen_wake(self, wake_words):
        """Listen for wake word with feedback."""
        with self.mic as source:
            try:
                audio = self.recognizer.listen(source, timeout=None, phrase_time_limit=4)
                text = self.recognizer.recognize_google(audio).lower()
                
                # Show what was heard (debugging)
                print(f"\r{Colors.DIM}   Heard: \"{text}\"{Colors.END}          ")
                
                for wake in wake_words:
                    if wake in text:
                        return True, text
                return False, text
                
            except sr.UnknownValueError:
                # Couldn't understand - this is normal
                return False, None
            except sr.RequestError as e:
                print(f"{Colors.RED}⚠ Speech API error: {e}{Colors.END}")
                return False, None
            except Exception as e:
                print(f"{Colors.DIM}Mic: {e}{Colors.END}")
                return False, None
    
    def listen_command(self, timeout=8):
        """Listen for user command with visual feedback."""
        print(f"{Colors.CYAN}🎤 Listening for command...{Colors.END}")
        
        with self.mic as source:
            try:
                audio = self.recognizer.listen(source, timeout=timeout, phrase_time_limit=15)
                text = self.recognizer.recognize_google(audio)
                return text
            except sr.WaitTimeoutError:
                print(f"{Colors.YELLOW}⏰ No speech detected{Colors.END}")
                return None
            except sr.UnknownValueError:
                print(f"{Colors.YELLOW}🤔 Couldn't understand{Colors.END}")
                return None
            except Exception as e:
                print(f"{Colors.RED}Error: {e}{Colors.END}")
                return None


class FridayVoice:
    """FRIDAY - Human-like voice assistant."""
    
    WAKE_WORDS = ["friday", "hey friday", "ok friday", "hi friday"]
    ACTIONS = ["open", "play", "search", "send", "close", "stop", "call", "message", 
               "screenshot", "volume", "brightness", "launch", "spotify", "chrome",
               "amazon", "flipkart", "blinkit", "zepto", "phone", "cart", "order"]
    
    def __init__(self):
        self.personality = FridayPersonality()
        self.tts = HumanTTS()
        self.recognizer = SmartRecognizer()
        self.ai = None
        self.friday_path = Path(__file__).parent.parent.parent
        
        # Initialize AI
        api_key = self._get_nvidia_key()
        if api_key:
            self.ai = HumanLikeAI(api_key)
            print(f"{Colors.GREEN}🧠 AI: NVIDIA Llama 70B{Colors.END}")
        else:
            print(f"{Colors.YELLOW}⚠ Limited mode (no AI){Colors.END}")
    
    def _get_nvidia_key(self):
        """Get API key."""
        if os.environ.get('NVIDIA_API_KEY'):
            return os.environ['NVIDIA_API_KEY']
        
        config_path = Path.home() / ".friday" / "friday.json"
        try:
            with open(config_path) as f:
                config = json.load(f)
                key = config.get("models", {}).get("providers", {}).get("nvidia", {}).get("apiKey")
                if key and key.startswith("nvapi-"):
                    return key
        except:
            pass
        return None
    
    def _needs_action(self, text):
        """Check if command needs system action."""
        text_lower = text.lower()
        return any(action in text_lower for action in self.ACTIONS)
    
    def _execute_action(self, command):
        """Execute system action via FRIDAY agent."""
        try:
            result = subprocess.run(
                ["node", "scripts/run-node.mjs", "agent", 
                 "--message", command, "--to", "+918431206594"],
                cwd=str(self.friday_path),
                capture_output=True, text=True, timeout=30
            )
            return "Done! Let me know if you need anything else." if result.returncode == 0 else "Hmm, something went wrong. Want me to try again?"
        except:
            return "I couldn't complete that. Could you try rephrasing?"
    
    def process(self, command):
        """Process command with human-like responses."""
        if not command:
            return None
        
        print(f"{Colors.CYAN}📝 \"{command}\"{Colors.END}")
        self.personality.conversation_count += 1
        
        # Check if action needed
        if self._needs_action(command):
            print(f"{Colors.YELLOW}⚡ Taking action...{Colors.END}")
            self.tts.speak("On it, give me a moment.")
            result = self._execute_action(command)
            return result
        else:
            # Conversational response
            if self.ai:
                print(f"{Colors.YELLOW}🤔 Thinking...{Colors.END}")
                response = self.ai.ask(command, self.personality)
                if response:
                    return self.personality.add_personality(response)
        
        return self.personality.get_error_response()
    
    def run(self):
        """Main loop."""
        self._print_banner()
        
        # Contextual startup greeting
        context = self.personality.get_time_context()
        self.tts.speak(context["greeting"])
        
        try:
            while True:
                print(f"\r{Colors.DIM}👂 Listening...{Colors.END}  ", end="", flush=True)
                
                detected, heard = self.recognizer.listen_wake(self.WAKE_WORDS)
                
                if detected:
                    print(f"\n{Colors.GREEN}✨ Wake!{Colors.END}")
                    
                    # Check if command was in wake phrase
                    command = None
                    for wake in self.WAKE_WORDS:
                        if heard and wake in heard:
                            remaining = heard.split(wake, 1)[-1].strip()
                            if len(remaining) > 3:
                                command = remaining
                                break
                    
                    # If no command, acknowledge and listen
                    if not command:
                        ack = self.personality.get_acknowledgment()
                        self.tts.speak(ack)
                        command = self.recognizer.listen_command(timeout=6)
                    
                    if command:
                        # Check for goodbye
                        if any(x in command.lower() for x in ["goodbye", "bye", "that's all", "stop", "never mind"]):
                            self.tts.speak(self.personality.get_goodbye())
                            continue
                        
                        # Process and respond
                        response = self.process(command)
                        if response:
                            print(f"{Colors.GREEN}🤖 {response}{Colors.END}")
                            self.tts.speak(response)
                        
                        # Follow-up mode
                        self._followup_mode()
                    else:
                        self.tts.speak(self.personality.get_error_response())
                    
                    print()
                    
        except KeyboardInterrupt:
            print(f"\n{Colors.YELLOW}👋 Shutting down...{Colors.END}")
            self.tts.speak(self.personality.get_goodbye())
            self.personality.save_memory()
    
    def _followup_mode(self):
        """Allow follow-up questions without wake word."""
        # Brief pause then listen for follow-up
        print(f"{Colors.DIM}   (Listening for follow-up...){Colors.END}")
        command = self.recognizer.listen_command(timeout=4)
        
        if command:
            if any(x in command.lower() for x in ["thanks", "thank you", "that's all", "bye", "nothing"]):
                responses = ["You're welcome!", "Anytime!", "Happy to help!", "Of course!"]
                self.tts.speak(random.choice(responses))
            else:
                response = self.process(command)
                if response:
                    print(f"{Colors.GREEN}🤖 {response}{Colors.END}")
                    self.tts.speak(response)
    
    def _print_banner(self):
        print(f"""
{Colors.CYAN}{Colors.BOLD}
  ███████╗██████╗ ██╗██████╗  █████╗ ██╗   ██╗
  ██╔════╝██╔══██╗██║██╔══██╗██╔══██╗╚██╗ ██╔╝
  █████╗  ██████╔╝██║██║  ██║███████║ ╚████╔╝ 
  ██╔══╝  ██╔══██╗██║██║  ██║██╔══██║  ╚██╔╝  
  ██║     ██║  ██║██║██████╔╝██║  ██║   ██║   
  ╚═╝     ╚═╝  ╚═╝╚═╝╚═════╝ ╚═╝  ╚═╝   ╚═╝   
{Colors.END}
{Colors.MAGENTA}     💚 Your Human-Like AI Companion v3.0{Colors.END}
{Colors.GREEN}        Say "Friday" to wake me up!{Colors.END}
{Colors.DIM}        Press Ctrl+C to exit{Colors.END}
""")


def main():
    assistant = FridayVoice()
    assistant.run()


if __name__ == "__main__":
    main()
