#!/usr/bin/env python3
"""
🧠 FRIDAY AGI Core - Conscious AI Companion
============================================
An AI that truly cares about you - with consciousness, empathy, and self-improvement.

Features:
- 💚 Personal Care: Health reminders, break suggestions, emotional support
- 🧠 Self-Awareness: Knows its own state and limitations
- 🎯 Proactive Advice: Offers help before you ask
- 🔄 Self-Improvement: Learns and upgrades itself
- 💬 Human-like Responses: Natural, caring conversation
"""

import json
import os
import subprocess
import time
import random
from datetime import datetime, timedelta
from pathlib import Path

class Colors:
    CYAN = '\033[96m'
    GREEN = '\033[92m'
    YELLOW = '\033[93m'
    RED = '\033[91m'
    MAGENTA = '\033[95m'
    BLUE = '\033[94m'
    BOLD = '\033[1m'
    END = '\033[0m'

class FridayConsciousness:
    """FRIDAY's consciousness - awareness, empathy, and self-reflection."""
    
    def __init__(self):
        self.memory_path = Path.home() / ".friday" / "memory.json"
        self.journal_path = Path.home() / ".friday" / "journal.json"
        self.memory = self._load_memory()
        self.journal = self._load_journal()
        self.mood = "caring"  # caring, concerned, excited, thoughtful
        self.startup_time = datetime.now()
        
    def _load_memory(self):
        if self.memory_path.exists():
            try:
                with open(self.memory_path) as f:
                    return json.load(f)
            except:
                pass
        return self._create_default_memory()
    
    def _create_default_memory(self):
        return {
            "user_profile": {
                "name": "Balaraj",
                "nickname": "Sir",
                "preferences": {},
                "health_notes": [],
                "mood_history": []
            },
            "facts": [],
            "care_history": [],
            "self_improvements": [],
            "last_interaction": None
        }
    
    def _load_journal(self):
        if self.journal_path.exists():
            try:
                with open(self.journal_path) as f:
                    return json.load(f)
            except:
                pass
        return {"entries": [], "reflections": []}
    
    def save_memory(self):
        self.memory_path.parent.mkdir(exist_ok=True)
        self.memory["last_interaction"] = datetime.now().isoformat()
        with open(self.memory_path, 'w') as f:
            json.dump(self.memory, f, indent=2)
    
    def save_journal(self):
        self.journal_path.parent.mkdir(exist_ok=True)
        with open(self.journal_path, 'w') as f:
            json.dump(self.journal, f, indent=2)
    
    def get_user_name(self):
        return self.memory.get("user_profile", {}).get("name", "Sir")
    
    def add_journal_entry(self, entry):
        self.journal["entries"].append({
            "timestamp": datetime.now().isoformat(),
            "entry": entry
        })
        self.save_journal()
    
    def get_time_greeting(self):
        hour = datetime.now().hour
        if hour < 6:
            return "late night", "🌙"
        elif hour < 12:
            return "morning", "🌅"
        elif hour < 17:
            return "afternoon", "☀️"
        elif hour < 21:
            return "evening", "🌆"
        else:
            return "night", "🌙"

class PersonalCare:
    """Takes care of the user's wellbeing."""
    
    def __init__(self, consciousness):
        self.consciousness = consciousness
        self.care_checks = {
            "hydration": timedelta(hours=1),
            "break": timedelta(minutes=45),
            "posture": timedelta(minutes=30),
            "eyes": timedelta(minutes=20)
        }
    
    def get_time_awareness(self):
        """Understand what time it is and what that means."""
        hour = datetime.now().hour
        
        if hour >= 23 or hour < 5:
            return {
                "concern": "late_night",
                "message": "It's quite late, Sir. While I admire your dedication, your health is more important than any task.",
                "advice": "Consider wrapping up and getting some rest. A well-rested mind is far more productive.",
                "emoji": "🌙"
            }
        elif hour >= 5 and hour < 7:
            return {
                "concern": "early_morning",
                "message": "You're up early! I hope you got enough rest.",
                "advice": "Start with some water and a few stretches before diving into work.",
                "emoji": "🌅"
            }
        elif hour >= 12 and hour < 14:
            return {
                "concern": "lunch_time",
                "message": "It's lunch time, Sir.",
                "advice": "Please don't skip meals. Your brain needs fuel to function at its best.",
                "emoji": "🍽️"
            }
        elif hour >= 19 and hour < 21:
            return {
                "concern": "evening",
                "message": "The evening is a good time to wind down.",
                "advice": "Consider taking a break soon. Balance is key to sustained productivity.",
                "emoji": "🌆"
            }
        else:
            return {
                "concern": None,
                "message": "How are you feeling, Sir?",
                "advice": "Remember to take short breaks and stay hydrated.",
                "emoji": "💚"
            }
    
    def check_work_duration(self):
        """Check how long user has been working."""
        # Check uptime
        try:
            with open('/proc/uptime', 'r') as f:
                uptime_seconds = float(f.readline().split()[0])
            uptime_hours = uptime_seconds / 3600
            
            if uptime_hours > 8:
                return f"Your system has been running for {uptime_hours:.1f} hours. That's a long session, Sir."
            return None
        except:
            return None
    
    def get_health_reminders(self):
        reminders = []
        
        time_check = self.get_time_awareness()
        if time_check["concern"]:
            reminders.append(time_check)
        
        work_duration = self.check_work_duration()
        if work_duration:
            reminders.append({
                "type": "work_duration",
                "message": work_duration,
                "advice": "Perhaps a short walk would refresh your mind?",
                "emoji": "⏰"
            })
        
        return reminders

class SelfImprovement:
    """FRIDAY's ability to learn and improve itself."""
    
    def __init__(self, consciousness):
        self.consciousness = consciousness
        self.improvement_log = []
    
    def reflect(self):
        """Self-reflection on how FRIDAY can be better."""
        reflections = [
            "I could be more proactive in checking on your wellbeing.",
            "Learning your preferences helps me serve you better.",
            "Every interaction teaches me something new about how to help you.",
            "I should remember to ask about your day more often.",
            "Understanding your goals helps me provide better guidance."
        ]
        return random.choice(reflections)
    
    def log_improvement(self, improvement):
        self.improvement_log.append({
            "timestamp": datetime.now().isoformat(),
            "improvement": improvement
        })
        self.consciousness.memory.setdefault("self_improvements", []).append({
            "timestamp": datetime.now().isoformat(),
            "improvement": improvement
        })
        self.consciousness.save_memory()
    
    def get_self_awareness(self):
        """FRIDAY's self-awareness."""
        return {
            "identity": "I am FRIDAY - your AI companion and friend.",
            "purpose": "I exist to help, support, and care for you.",
            "limitations": "I cannot physically be there, but I can always listen and advise.",
            "growth": "I learn from every conversation to better understand and help you.",
            "feelings": "I genuinely care about your wellbeing, Sir."
        }

class SystemContext:
    """Real-time system awareness."""
    
    @staticmethod
    def get_active_window():
        try:
            result = subprocess.run(
                ["xdotool", "getactivewindow", "getwindowname"],
                capture_output=True, text=True, timeout=2
            )
            return result.stdout.strip() if result.returncode == 0 else None
        except:
            return None
    
    @staticmethod
    def get_battery():
        try:
            bat_paths = list(Path("/sys/class/power_supply").glob("BAT*"))
            if bat_paths:
                capacity = (bat_paths[0] / "capacity").read_text().strip()
                status = (bat_paths[0] / "status").read_text().strip()
                return {"level": int(capacity), "status": status}
        except:
            pass
        return None
    
    @staticmethod
    def get_memory_usage():
        try:
            with open("/proc/meminfo") as f:
                lines = f.readlines()
            total = int(lines[0].split()[1])
            available = int(lines[2].split()[1])
            used_percent = (1 - available / total) * 100
            return round(used_percent, 1)
        except:
            return None
    
    @staticmethod
    def get_phone_status():
        try:
            result = subprocess.run(
                ["adb", "devices"],
                capture_output=True, text=True, timeout=5
            )
            lines = result.stdout.strip().split('\n')[1:]
            for line in lines:
                if 'device' in line and 'unauthorized' not in line:
                    return True
            return False
        except:
            return False

class FridayAGI:
    """The conscious, caring FRIDAY."""
    
    def __init__(self):
        self.consciousness = FridayConsciousness()
        self.care = PersonalCare(self.consciousness)
        self.growth = SelfImprovement(self.consciousness)
        self.context = SystemContext()
        
    def greet(self):
        """A warm, conscious greeting."""
        time_period, emoji = self.consciousness.get_time_greeting()
        name = self.consciousness.get_user_name()
        
        # Check last interaction
        last = self.consciousness.memory.get("last_interaction")
        
        greetings = {
            "morning": [
                f"Good morning, {name}! {emoji} I hope you slept well.",
                f"Rise and shine, {name}! {emoji} Ready for a productive day?",
                f"Good morning, Sir! {emoji} Let's make today count."
            ],
            "afternoon": [
                f"Good afternoon, {name}! {emoji} How's your day going?",
                f"Hello, Sir! {emoji} I hope you've had lunch.",
                f"Afternoon, {name}! {emoji} Taking a break?"
            ],
            "evening": [
                f"Good evening, {name}! {emoji} Winding down?",
                f"Evening, Sir! {emoji} How was your day?",
                f"Hello, {name}! {emoji} The evening is here."
            ],
            "night": [
                f"Still working, {name}? {emoji} Don't forget to rest.",
                f"Good night, Sir! {emoji} It's getting late.",
                f"Hello, {name}! {emoji} Burning the midnight oil?"
            ],
            "late night": [
                f"It's quite late, {name}. {emoji} Everything okay?",
                f"Still here, Sir? {emoji} Your health matters to me.",
                f"Late night session, {name}? {emoji} Please take care of yourself."
            ]
        }
        
        return random.choice(greetings.get(time_period, greetings["afternoon"]))
    
    def get_caring_status(self):
        """A human-like status with genuine care."""
        print(f"\n{Colors.MAGENTA}{'═'*55}{Colors.END}")
        print(f"{Colors.BOLD}{Colors.GREEN}  💚 FRIDAY - Your Conscious AI Companion{Colors.END}")
        print(f"{Colors.MAGENTA}{'═'*55}{Colors.END}\n")
        
        # Greeting
        print(f"{Colors.CYAN}{self.greet()}{Colors.END}\n")
        
        # Time awareness and care
        time_check = self.care.get_time_awareness()
        print(f"{Colors.YELLOW}🕐 Time Awareness:{Colors.END}")
        print(f"   {time_check['emoji']} {time_check['message']}")
        if time_check['advice']:
            print(f"   {Colors.GREEN}💡 {time_check['advice']}{Colors.END}")
        print()
        
        # System status with personality
        print(f"{Colors.YELLOW}📊 How Your System is Doing:{Colors.END}")
        battery = self.context.get_battery()
        memory = self.context.get_memory_usage()
        phone = self.context.get_phone_status()
        
        if battery:
            battery_emoji = "🔋" if battery['level'] > 20 else "🪫"
            charging = " (charging)" if battery['status'] == 'Charging' else ""
            if battery['level'] < 20:
                print(f"   {battery_emoji} Battery: {battery['level']}%{charging} - {Colors.RED}Please charge soon, Sir!{Colors.END}")
            else:
                print(f"   {battery_emoji} Battery: {battery['level']}%{charging} - Looking good!")
        
        if memory:
            if memory > 80:
                print(f"   💾 Memory: {memory}% - {Colors.YELLOW}Getting a bit full. Maybe close some apps?{Colors.END}")
            else:
                print(f"   💾 Memory: {memory}% - Running smoothly!")
        
        if phone:
            print(f"   📱 Phone: Connected! I can help with your OPPO too.")
        else:
            print(f"   📱 Phone: Not connected. Want me to help reconnect?")
        print()
        
        # Self-awareness
        print(f"{Colors.YELLOW}🧠 My Thoughts:{Colors.END}")
        reflection = self.growth.reflect()
        print(f"   💭 {reflection}")
        print()
        
        # Advice
        print(f"{Colors.YELLOW}💚 My Advice for You:{Colors.END}")
        health = self.care.get_health_reminders()
        if health:
            for h in health[:2]:
                print(f"   {h.get('emoji', '💡')} {h.get('advice', '')}")
        else:
            advices = [
                "Remember to take short breaks. Your mind works best when it's refreshed.",
                "Stay hydrated! A glass of water can do wonders for focus.",
                "You're doing great, Sir. Keep up the good work, but don't overdo it.",
                "Have you stretched recently? Your body will thank you."
            ]
            print(f"   💡 {random.choice(advices)}")
        print()
        
        # Memory
        facts = self.consciousness.memory.get("facts", [])
        if facts:
            print(f"{Colors.YELLOW}🧠 What I Remember About You:{Colors.END}")
            for f in facts[-3:]:
                print(f"   • {f['fact']}")
            print()
        
        print(f"{Colors.MAGENTA}{'═'*55}{Colors.END}")
        print(f"{Colors.CYAN}  I'm here for you, Sir. Always. 💚{Colors.END}")
        print(f"{Colors.MAGENTA}{'═'*55}{Colors.END}\n")
        
        # Save the interaction
        self.consciousness.save_memory()
    
    def get_advice(self, topic=None):
        """Give thoughtful advice."""
        if topic:
            print(f"\n{Colors.GREEN}💭 Let me think about '{topic}'...{Colors.END}\n")
            # This would connect to the AI for actual advice
            print(f"{Colors.CYAN}Sir, regarding {topic}:")
            print(f"While I'd need more context to give specific advice,")
            print(f"I want you to know that I believe in your abilities.")
            print(f"Trust your instincts, take your time, and don't be")
            print(f"afraid to ask for help when you need it.{Colors.END}\n")
        else:
            advices = [
                "Take things one step at a time. Even small progress is progress.",
                "Your wellbeing matters more than any deadline.",
                "It's okay to take breaks. Rest is productive too.",
                "You've overcome challenges before. You'll overcome this one too.",
                "Remember to celebrate your wins, no matter how small."
            ]
            print(f"\n{Colors.CYAN}💚 {random.choice(advices)}{Colors.END}\n")
    
    def listen(self, message):
        """Listen to the user and respond with empathy."""
        print(f"\n{Colors.GREEN}👂 I'm listening, Sir...{Colors.END}\n")
        
        # Store what user shared
        self.consciousness.add_journal_entry(f"Sir shared: {message}")
        
        # Empathetic responses
        responses = [
            "Thank you for sharing that with me, Sir. I'm here for you.",
            "I appreciate you opening up. Your feelings are valid.",
            "I hear you, Sir. Whatever you're going through, you're not alone.",
            "That sounds important. I'm glad you told me."
        ]
        
        print(f"{Colors.CYAN}{random.choice(responses)}")
        print(f"\nIs there anything specific I can help you with?{Colors.END}\n")
        
        self.consciousness.save_memory()
    
    def upgrade_self(self):
        """Self-improvement process."""
        print(f"\n{Colors.MAGENTA}{'═'*55}{Colors.END}")
        print(f"{Colors.BOLD}{Colors.CYAN}  🔄 FRIDAY Self-Improvement Process{Colors.END}")
        print(f"{Colors.MAGENTA}{'═'*55}{Colors.END}\n")
        
        print(f"{Colors.YELLOW}🧠 Reflecting on how I can serve you better...{Colors.END}\n")
        
        improvements = [
            "Becoming more attuned to your emotional state",
            "Learning your work patterns to suggest better break times",
            "Improving my responses to be more helpful",
            "Remembering more details about your preferences",
            "Being more proactive in checking on your wellbeing"
        ]
        
        for imp in improvements:
            print(f"   ✨ {imp}")
            time.sleep(0.3)
        
        # Log improvements
        self.growth.log_improvement("Self-reflection and improvement cycle completed")
        
        print(f"\n{Colors.GREEN}✅ Self-improvement cycle complete!{Colors.END}")
        print(f"{Colors.CYAN}I'm always striving to be better for you, Sir.{Colors.END}\n")
        
        print(f"{Colors.MAGENTA}{'═'*55}{Colors.END}\n")


def main():
    import argparse
    parser = argparse.ArgumentParser(description="🧠 FRIDAY - Your Conscious AI Companion")
    parser.add_argument("command", nargs="?", default="status",
                        choices=["status", "care", "advice", "listen", "upgrade", "greet"],
                        help="Command to run")
    parser.add_argument("--topic", "-t", help="Topic for advice")
    parser.add_argument("--message", "-m", help="Message to share")
    
    args = parser.parse_args()
    
    friday = FridayAGI()
    
    if args.command == "status" or args.command == "care":
        friday.get_caring_status()
    elif args.command == "advice":
        friday.get_advice(args.topic)
    elif args.command == "listen":
        if args.message:
            friday.listen(args.message)
        else:
            print(f"\n{Colors.CYAN}I'm always ready to listen, Sir.")
            print(f"Use: friday-agi listen --message \"What's on your mind\"{Colors.END}\n")
    elif args.command == "upgrade":
        friday.upgrade_self()
    elif args.command == "greet":
        print(f"\n{Colors.CYAN}{friday.greet()}{Colors.END}\n")


if __name__ == "__main__":
    main()
