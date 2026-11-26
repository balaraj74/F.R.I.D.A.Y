#!/usr/bin/env python3
"""
📞 FRIDAY Proactive Care System
================================
Calls you to remind tasks, say good morning, and check on your wellbeing.

Features:
- Morning wake-up calls with personalized greeting
- Task reminders via phone calls
- Break reminders
- End of day wrap-up calls
"""

import os
import subprocess
import json
import time
import random
from datetime import datetime, timedelta
from pathlib import Path
import threading
import schedule

class Colors:
    CYAN = '\033[96m'
    GREEN = '\033[92m'
    YELLOW = '\033[93m'
    RED = '\033[91m'
    MAGENTA = '\033[95m'
    END = '\033[0m'

# FRIDAY's caring messages
GREETINGS = {
    "morning": [
        "Good morning, Sir! Rise and shine! It's a beautiful day to accomplish great things.",
        "Good morning, Boss! Hope you slept well. Ready to take on the day?",
        "Morning, Sir! Your loyal assistant is here. Let's make today amazing!",
        "Good morning! The sun is up, and so am I. What shall we conquer today?",
    ],
    "afternoon": [
        "Good afternoon, Sir! How's your day going so far?",
        "Hey! Just checking in. Have you had lunch yet?",
        "Afternoon check-in! Making progress on your tasks?",
    ],
    "evening": [
        "Good evening, Sir! The day is winding down. How did things go?",
        "Evening, Boss! Time to start wrapping up for the day.",
        "Hey! The evening's here. Don't forget to take a break.",
    ],
    "night": [
        "Sir, it's getting late. Please get some rest soon.",
        "Hey, just a gentle reminder - your health is important. Time for bed?",
        "Good night, Sir! Tomorrow is another day to shine.",
    ]
}

REMINDERS = {
    "hydration": [
        "Hey Sir, just a quick reminder to drink some water! Stay hydrated.",
        "Time to grab a glass of water! Your body will thank you.",
    ],
    "break": [
        "You've been working for a while. How about a short break?",
        "Sir, remember to stretch! Take a 5 minute break.",
        "Quick reminder: Looking away from the screen helps your eyes. Take a break!",
    ],
    "posture": [
        "Posture check! Sit up straight, Sir.",
        "Hey, just checking - how's your posture? Straighten up!",
    ]
}


class FridayReminder:
    """Proactive reminder and care system."""
    
    def __init__(self):
        self.user_phone = os.environ.get("FRIDAY_USER_PHONE", "")  # set to enable phone reminders
        self.reminders_file = Path.home() / ".friday" / "reminders.json"
        self.reminders = self._load_reminders()
        self.last_call_time = None
        
    def _load_reminders(self):
        """Load user's reminders."""
        if self.reminders_file.exists():
            try:
                with open(self.reminders_file) as f:
                    return json.load(f)
            except:
                pass
        return {
            "tasks": [],
            "schedules": {
                "morning_call": "07:00",
                "lunch_reminder": "13:00",
                "evening_wrapup": "18:00",
                "night_reminder": "22:00"
            },
            "enabled": True
        }
    
    def save_reminders(self):
        """Save reminders to file."""
        self.reminders_file.parent.mkdir(exist_ok=True)
        with open(self.reminders_file, 'w') as f:
            json.dump(self.reminders, f, indent=2)
    
    def get_time_period(self):
        """Get current time period."""
        hour = datetime.now().hour
        if 5 <= hour < 12:
            return "morning"
        elif 12 <= hour < 17:
            return "afternoon"
        elif 17 <= hour < 21:
            return "evening"
        else:
            return "night"
    
    def speak_on_phone(self, message):
        """Make phone speak using TTS (send via adb)."""
        # Use Android TTS via adb
        try:
            # Escape message for shell
            escaped = message.replace("'", "\\'").replace('"', '\\"')
            
            # Use am broadcast to trigger TTS (requires helper app)
            # For now, we'll send a notification with the message
            subprocess.run([
                "adb", "shell", 
                f"am", "start", "-a", "android.intent.action.CALL",
                "-d", f"tel:{self.user_phone}"
            ], capture_output=True, timeout=10)
            
            print(f"{Colors.GREEN}📞 Calling {self.user_phone}...{Colors.END}")
            print(f"{Colors.CYAN}   Message: {message}{Colors.END}")
            
            return True
        except Exception as e:
            print(f"{Colors.RED}❌ Call failed: {e}{Colors.END}")
            return False
    
    def send_notification(self, title, message):
        """Send notification to phone."""
        try:
            # Send via termux-notification if available
            subprocess.run([
                "adb", "shell",
                f"am broadcast -a net.texh.friday.NOTIFY "
                f"--es title '{title}' --es message '{message}'"
            ], capture_output=True, timeout=10)
            
            # Also show desktop notification
            subprocess.run([
                "notify-send", "-i", "dialog-information",
                f"FRIDAY: {title}", message
            ], capture_output=True, timeout=5)
            
            print(f"{Colors.GREEN}📱 Notification sent: {title}{Colors.END}")
            return True
        except:
            return False
    
    def morning_call(self):
        """Good morning call."""
        period = self.get_time_period()
        if period != "morning":
            return
        
        message = random.choice(GREETINGS["morning"])
        
        # Get today's tasks
        tasks = self.reminders.get("tasks", [])
        if tasks:
            message += f" You have {len(tasks)} tasks for today."
        
        print(f"\n{Colors.MAGENTA}🌅 MORNING CALL{Colors.END}")
        self.send_notification("Good Morning!", message)
        
        # Speak on laptop
        self._speak_local(message)
    
    def lunch_reminder(self):
        """Lunch break reminder."""
        message = random.choice([
            "It's lunch time! Please take a break and eat something healthy.",
            "Hey Sir, don't skip lunch! Your brain needs fuel.",
            "Lunchtime reminder! Step away from the screen and enjoy your meal."
        ])
        
        print(f"\n{Colors.YELLOW}🍽️ LUNCH REMINDER{Colors.END}")
        self.send_notification("Lunch Time!", message)
        self._speak_local(message)
    
    def break_reminder(self):
        """Take a break reminder."""
        message = random.choice(REMINDERS["break"])
        
        print(f"\n{Colors.CYAN}☕ BREAK REMINDER{Colors.END}")
        self.send_notification("Take a Break", message)
        self._speak_local(message)
    
    def hydration_reminder(self):
        """Drink water reminder."""
        message = random.choice(REMINDERS["hydration"])
        
        print(f"\n{Colors.CYAN}💧 HYDRATION REMINDER{Colors.END}")
        self.send_notification("Stay Hydrated!", message)
        self._speak_local(message)
    
    def evening_wrapup(self):
        """Evening wrap-up call."""
        message = random.choice(GREETINGS["evening"])
        
        pending = len([t for t in self.reminders.get("tasks", []) if not t.get("done")])
        if pending:
            message += f" You still have {pending} pending tasks."
        
        print(f"\n{Colors.MAGENTA}🌆 EVENING WRAP-UP{Colors.END}")
        self.send_notification("Evening Wrap-up", message)
        self._speak_local(message)
    
    def night_reminder(self):
        """Night time - go to sleep reminder."""
        message = random.choice(GREETINGS["night"])
        
        print(f"\n{Colors.MAGENTA}🌙 NIGHT REMINDER{Colors.END}")
        self.send_notification("Time for Rest", message)
        self._speak_local(message)
    
    def task_reminder(self, task):
        """Remind about a specific task."""
        message = f"Reminder: {task}. This is on your task list, Sir."
        
        print(f"\n{Colors.YELLOW}📋 TASK REMINDER{Colors.END}")
        self.send_notification("Task Reminder", message)
        self._speak_local(message)
    
    def add_task(self, task, time=None):
        """Add a task to remind about."""
        self.reminders.setdefault("tasks", []).append({
            "task": task,
            "time": time,
            "created": datetime.now().isoformat(),
            "done": False
        })
        self.save_reminders()
        print(f"{Colors.GREEN}✅ Task added: {task}{Colors.END}")
    
    def list_tasks(self):
        """List all tasks."""
        tasks = self.reminders.get("tasks", [])
        if not tasks:
            print(f"{Colors.YELLOW}No tasks scheduled.{Colors.END}")
            return
        
        print(f"\n{Colors.CYAN}📋 Your Tasks:{Colors.END}")
        for i, t in enumerate(tasks, 1):
            status = "✅" if t.get("done") else "⬜"
            time_str = f" @ {t['time']}" if t.get('time') else ""
            print(f"   {status} {i}. {t['task']}{time_str}")
    
    def _speak_local(self, message):
        """Speak on laptop using Edge TTS."""
        try:
            import asyncio
            import tempfile
            import edge_tts
            
            async def speak():
                with tempfile.NamedTemporaryFile(suffix='.mp3', delete=False) as f:
                    audio_path = f.name
                
                communicate = edge_tts.Communicate(message, "en-US-JennyNeural")
                await communicate.save(audio_path)
                
                subprocess.run(
                    ["mpv", "--no-video", "--really-quiet", audio_path],
                    capture_output=True, timeout=60
                )
            
            asyncio.run(speak())
        except Exception as e:
            print(f"{Colors.DIM}TTS: {e}{Colors.END}")
    
    def start_scheduler(self):
        """Start the reminder scheduler."""
        print(f"\n{Colors.GREEN}🕐 FRIDAY Reminder Scheduler Started{Colors.END}")
        print(f"{Colors.CYAN}   Schedules:{Colors.END}")
        
        schedules = self.reminders.get("schedules", {})
        
        # Morning call
        if "morning_call" in schedules:
            schedule.every().day.at(schedules["morning_call"]).do(self.morning_call)
            print(f"   🌅 Morning call: {schedules['morning_call']}")
        
        # Lunch reminder
        if "lunch_reminder" in schedules:
            schedule.every().day.at(schedules["lunch_reminder"]).do(self.lunch_reminder)
            print(f"   🍽️ Lunch reminder: {schedules['lunch_reminder']}")
        
        # Evening wrap-up
        if "evening_wrapup" in schedules:
            schedule.every().day.at(schedules["evening_wrapup"]).do(self.evening_wrapup)
            print(f"   🌆 Evening wrap-up: {schedules['evening_wrapup']}")
        
        # Night reminder
        if "night_reminder" in schedules:
            schedule.every().day.at(schedules["night_reminder"]).do(self.night_reminder)
            print(f"   🌙 Night reminder: {schedules['night_reminder']}")
        
        # Hourly hydration
        schedule.every(2).hours.do(self.hydration_reminder)
        print(f"   💧 Hydration: Every 2 hours")
        
        # Break reminder every 90 mins
        schedule.every(90).minutes.do(self.break_reminder)
        print(f"   ☕ Break: Every 90 minutes")
        
        print(f"\n{Colors.GREEN}Press Ctrl+C to stop.{Colors.END}\n")
        
        while True:
            schedule.run_pending()
            time.sleep(60)


def main():
    import sys
    
    reminder = FridayReminder()
    
    if len(sys.argv) < 2:
        print(f"""
{Colors.CYAN}📞 FRIDAY Reminder System{Colors.END}

Usage:
  friday-remind start        - Start the scheduler
  friday-remind add "task"   - Add a task reminder
  friday-remind list         - List all tasks
  friday-remind morning      - Send morning greeting now
  friday-remind check        - Check in now
  friday-remind test         - Test notification
""")
        return
    
    cmd = sys.argv[1]
    
    if cmd == "start":
        reminder.start_scheduler()
    elif cmd == "add" and len(sys.argv) > 2:
        task = " ".join(sys.argv[2:])
        reminder.add_task(task)
    elif cmd == "list":
        reminder.list_tasks()
    elif cmd == "morning":
        reminder.morning_call()
    elif cmd == "check":
        period = reminder.get_time_period()
        message = random.choice(GREETINGS[period])
        print(f"{Colors.GREEN}{message}{Colors.END}")
        reminder._speak_local(message)
    elif cmd == "test":
        reminder.send_notification("Test", "FRIDAY reminder system is working!")
        reminder._speak_local("This is a test of the FRIDAY reminder system.")
    else:
        print(f"{Colors.RED}Unknown command: {cmd}{Colors.END}")


if __name__ == "__main__":
    main()
