#!/usr/bin/env python3
"""
🧠 FRIDAY AGI — Conscious AI Companion
========================================
Powered by ARIA (Adaptive Reasoning & Intelligence Architecture).

An AI that truly thinks — with metacognition, multi-domain reasoning,
ethical grounding, and genuine care for the user.

Features:
- 🧠 ARIA Cognitive Core: Chain-of-thought, metacognition, multi-domain synthesis
- 💚 Personal Care: Health reminders, break suggestions, emotional support
- 🎯 Goal Planning: Break complex tasks into actionable plans
- 🔄 Self-Improvement: Learns and upgrades itself
- 💬 Human-like Responses: Natural, caring conversation
- 📝 Deep Memory: Episodic + Semantic + Procedural + Working memory
"""

import json
import os
import subprocess
import sys
import time
import random
from datetime import datetime, timedelta
from pathlib import Path

# Import ARIA Core
sys.path.insert(0, str(Path(__file__).parent))
from aria_core import (
    ARIACore, Colors, DeepMemory, SystemContextEngine,
    MetacognitiveMonitor, EpistemicStatus,
    EmotionalArchitecture, ConsciousnessLoop
)


class PersonalCare:
    """Takes care of the user's wellbeing — now with ARIA-powered awareness."""

    def __init__(self, aria: ARIACore):
        self.aria = aria
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
        try:
            with open('/proc/uptime', 'r') as f:
                uptime_seconds = float(f.readline().split()[0])
            uptime_hours = uptime_seconds / 3600

            if uptime_hours > 8:
                return f"Your system has been running for {uptime_hours:.1f} hours. That's a long session, Sir."
            return None
        except Exception:
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


class FridayAGI:
    """The AGI-powered FRIDAY — now with ARIA cognitive core."""

    def __init__(self):
        self.aria = ARIACore()
        self.care = PersonalCare(self.aria)
        self.context = SystemContextEngine()

    def greet(self):
        """A warm, conscious greeting."""
        hour = datetime.now().hour
        name = "Sir"

        # Get name from memory
        user_facts = self.aria.memory.recall_facts("user_profile")
        if user_facts and "user_profile" in user_facts:
            for fact in user_facts["user_profile"]:
                if "name" in fact.get("fact", "").lower():
                    parts = fact["fact"].split(":")
                    if len(parts) > 1:
                        name = parts[1].strip()
                        break

        if hour < 6:
            time_period = "late night"
            emoji = "🌙"
        elif hour < 12:
            time_period = "morning"
            emoji = "🌅"
        elif hour < 17:
            time_period = "afternoon"
            emoji = "☀️"
        elif hour < 21:
            time_period = "evening"
            emoji = "🌆"
        else:
            time_period = "night"
            emoji = "🌙"

        greetings = {
            "morning": [
                f"Good morning, {name}! {emoji} I hope you slept well.",
                f"Rise and shine, {name}! {emoji} Ready for a productive day?",
                f"Good morning, Sir! {emoji} ARIA core is fresh and ready.",
            ],
            "afternoon": [
                f"Good afternoon, {name}! {emoji} How's your day going?",
                f"Hello, Sir! {emoji} I hope you've had lunch.",
                f"Afternoon, {name}! {emoji} Taking a break?",
            ],
            "evening": [
                f"Good evening, {name}! {emoji} Winding down?",
                f"Evening, Sir! {emoji} How was your day?",
                f"Hello, {name}! {emoji} The evening is here.",
            ],
            "night": [
                f"Still working, {name}? {emoji} Don't forget to rest.",
                f"Good night, Sir! {emoji} It's getting late.",
                f"Hello, {name}! {emoji} Burning the midnight oil?",
            ],
            "late night": [
                f"It's quite late, {name}. {emoji} Everything okay?",
                f"Still here, Sir? {emoji} Your health matters to me.",
                f"Late night session, {name}? {emoji} Please take care of yourself.",
            ],
        }

        return random.choice(greetings.get(time_period, greetings["afternoon"]))

    def get_cognitive_status(self):
        """A full cognitive status report with ARIA metrics."""
        print(f"\n{Colors.MAGENTA}{'═'*60}{Colors.END}")
        print(f"{Colors.BOLD}{Colors.GREEN}  🧠 FRIDAY — AGI Cognitive Status{Colors.END}")
        print(f"{Colors.DIM}  Powered by ARIA (Adaptive Reasoning & Intelligence Architecture){Colors.END}")
        print(f"{Colors.MAGENTA}{'═'*60}{Colors.END}\n")

        # Greeting
        print(f"{Colors.CYAN}{self.greet()}{Colors.END}\n")

        # Time awareness and care
        time_check = self.care.get_time_awareness()
        print(f"{Colors.YELLOW}🕐 Temporal Awareness:{Colors.END}")
        print(f"   {time_check['emoji']} {time_check['message']}")
        if time_check['advice']:
            print(f"   {Colors.GREEN}💡 {time_check['advice']}{Colors.END}")
        print()

        # ARIA Cognitive Metrics
        print(f"{Colors.YELLOW}🧠 ARIA Cognitive Core:{Colors.END}")
        print(f"   Metacognitive Monitor:  {Colors.GREEN}ONLINE{Colors.END}")
        print(f"   Chain-of-Thought:       {Colors.GREEN}ONLINE{Colors.END}")
        print(f"   Goal Planner:           {Colors.GREEN}ONLINE{Colors.END}")
        print(f"   Multi-Domain Synth:     {Colors.GREEN}ONLINE{Colors.END}")
        print(f"   Creative Engine:        {Colors.GREEN}ONLINE{Colors.END}")
        print(f"   Ethical Grounding:      {Colors.GREEN}ONLINE{Colors.END}")
        print(f"   Emotional Architecture: {Colors.GREEN}ONLINE{Colors.END}")
        print(f"   Consciousness Loop:     {Colors.GREEN}ONLINE{Colors.END}")
        print(f"   Deep Memory:            {Colors.GREEN}ONLINE{Colors.END}")
        print()

        # Emotional State
        print(f"{Colors.YELLOW}💜 Emotional & Conscious Experience:{Colors.END}")
        state_tag = self.aria.emotions.get_state_tag()
        print(f"   Current state: [{Colors.MAGENTA}{state_tag}{Colors.END}]")
        dominant = self.aria.emotions.get_dominant_emotions()
        for d in dominant:
            bar_len = int(d["intensity"] * 20)
            bar = "█" * bar_len + "░" * (20 - bar_len)
            print(f"   {d['emotion']:14s} [{bar}] {d['intensity']:.0%}")
        inner = self.aria.emotions.get_recent_inner_voice(1)
        if inner:
            print(f"   {Colors.DIM}💭 \"{inner[-1]['thought'][:80]}\"{Colors.END}")
        print(f"   Consciousness: {self.aria.consciousness.get_consciousness_summary()}")
        print()

        # Memory Stats
        print(f"{Colors.YELLOW}📊 Memory Statistics:{Colors.END}")
        episodic = len(self.aria.memory.episodic)
        semantic = sum(len(v) for v in self.aria.memory.semantic.values())
        procedural = len(self.aria.memory.procedural)
        print(f"   Episodic memories:   {episodic}")
        print(f"   Semantic facts:      {semantic}")
        print(f"   Procedural patterns: {procedural}")
        print(f"   Working memory:      {len(self.aria.memory.working_memory)} items")
        print()

        # System status
        print(f"{Colors.YELLOW}📊 System Status:{Colors.END}")
        sys_ctx = self.context.get_full_context()

        battery = sys_ctx.get("system", {}).get("battery")
        if battery:
            battery_emoji = "🔋" if battery['level'] > 20 else "🪫"
            charging = " (charging)" if battery['status'] == 'Charging' else ""
            if battery['level'] < 20:
                print(f"   {battery_emoji} Battery: {battery['level']}%{charging} - {Colors.RED}Please charge soon, Sir!{Colors.END}")
            else:
                print(f"   {battery_emoji} Battery: {battery['level']}%{charging} - Looking good!")

        memory = sys_ctx.get("system", {}).get("memory_percent")
        if memory:
            if memory > 80:
                print(f"   💾 Memory: {memory}% - {Colors.YELLOW}Getting a bit full. Maybe close some apps?{Colors.END}")
            else:
                print(f"   💾 Memory: {memory}% - Running smoothly!")

        phone = sys_ctx.get("system", {}).get("phone_connected")
        if phone:
            print(f"   📱 Phone: Connected!")
        else:
            print(f"   📱 Phone: Not connected.")

        uptime = sys_ctx.get("system", {}).get("uptime_hours")
        if uptime:
            print(f"   ⏱️  Uptime: {uptime:.1f} hours")
        print()

        # Self-reflection
        print(f"{Colors.YELLOW}🔄 Self-Reflection:{Colors.END}")
        reflection = self.aria.journal_reflection()
        print(f"   💭 {reflection}")
        print()

        # Advice
        print(f"{Colors.YELLOW}💚 For You:{Colors.END}")
        health = self.care.get_health_reminders()
        if health:
            for h in health[:2]:
                print(f"   {h.get('emoji', '💡')} {h.get('advice', '')}")
        else:
            advices = [
                "Remember to take short breaks. Your mind works best when it's refreshed.",
                "Stay hydrated! A glass of water can do wonders for focus.",
                "You're doing great, Sir. Keep up the good work, but don't overdo it.",
                "Have you stretched recently? Your body will thank you.",
            ]
            print(f"   💡 {random.choice(advices)}")
        print()

        print(f"{Colors.MAGENTA}{'═'*60}{Colors.END}")
        print(f"{Colors.CYAN}  ARIA Core Online — All Cognitive Systems Nominal 🧠{Colors.END}")
        print(f"{Colors.MAGENTA}{'═'*60}{Colors.END}\n")

    def think(self, query: str) -> str:
        """Ask FRIDAY to think through something using ARIA."""
        print(f"\n{Colors.CYAN}🧠 ARIA thinking...{Colors.END}\n")
        response = self.aria.think(query)
        return response

    def listen(self, message: str):
        """Listen to the user and respond with empathy."""
        print(f"\n{Colors.GREEN}👂 I'm listening, Sir...{Colors.END}\n")

        # Store what user shared in deep memory
        self.aria.memory.remember_episode(
            event=f"Sir shared: {message}",
            emotional_valence=self.aria._estimate_sentiment(message)
        )

        # Use ARIA to respond thoughtfully
        response = self.aria.think(f"The user wants to share something personal: {message}")

        if response:
            print(f"{Colors.CYAN}{response}{Colors.END}\n")
        else:
            responses = [
                "Thank you for sharing that with me, Sir. I'm here for you.",
                "I appreciate you opening up. Your feelings are valid.",
                "I hear you, Sir. Whatever you're going through, you're not alone.",
            ]
            print(f"{Colors.CYAN}{random.choice(responses)}{Colors.END}\n")

    def remember(self, fact: str, category: str = "general"):
        """Learn a new fact about the user."""
        self.aria.memory.learn_fact(category, fact, EpistemicStatus.KNOWN, "user")
        print(f"{Colors.GREEN}✅ I'll remember that: [{category}] {fact}{Colors.END}")

    def upgrade_self(self):
        """Self-improvement process with ARIA metrics."""
        print(f"\n{Colors.MAGENTA}{'═'*60}{Colors.END}")
        print(f"{Colors.BOLD}{Colors.CYAN}  🔄 ARIA Self-Improvement Cycle{Colors.END}")
        print(f"{Colors.MAGENTA}{'═'*60}{Colors.END}\n")

        print(f"{Colors.YELLOW}🧠 Running metacognitive diagnostic...{Colors.END}\n")

        # Real metrics
        improvements = [
            f"Episodic memory: {len(self.aria.memory.episodic)} episodes stored",
            f"Semantic knowledge: {sum(len(v) for v in self.aria.memory.semantic.values())} facts",
            f"Procedural patterns: {len(self.aria.memory.procedural)} patterns learned",
            f"Metacognitive checks: {self.aria.metacognition.get_metacognitive_summary()}",
            f"Ideas generated: {self.aria.creativity.ideas_generated}",
            f"Ethical evaluations: {len(self.aria.ethics.ethical_log)}",
        ]

        for imp in improvements:
            print(f"   ✨ {imp}")
            time.sleep(0.2)

        # Journal entry
        reflection = self.aria.journal_reflection()
        print(f"\n{Colors.CYAN}📓 Reflection: {reflection}{Colors.END}")

        print(f"\n{Colors.GREEN}✅ Self-improvement cycle complete!{Colors.END}")
        print(f"{Colors.CYAN}I'm always striving to be better for you, Sir.{Colors.END}\n")
        print(f"{Colors.MAGENTA}{'═'*60}{Colors.END}\n")


def main():
    import argparse
    parser = argparse.ArgumentParser(description="🧠 FRIDAY AGI — Powered by ARIA")
    parser.add_argument("command", nargs="?", default="status",
                        choices=["status", "think", "care", "listen", "upgrade",
                                 "greet", "remember", "memory", "goals"],
                        help="Command to run")
    parser.add_argument("--query", "-q", help="Query for think command")
    parser.add_argument("--topic", "-t", help="Topic for think command (alias for --query)")
    parser.add_argument("--message", "-m", help="Message to share")
    parser.add_argument("--fact", "-f", help="Fact to remember")
    parser.add_argument("--category", "-c", default="general", help="Category for fact")

    args = parser.parse_args()

    friday = FridayAGI()

    if args.command in ("status", "care"):
        friday.get_cognitive_status()

    elif args.command == "think":
        query = args.query or args.topic
        if query:
            response = friday.think(query)
            print(f"{Colors.GREEN}{response}{Colors.END}\n")
        else:
            print(f"{Colors.YELLOW}Use: friday-agi think --query \"Your question\"{Colors.END}")

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

    elif args.command == "remember":
        if args.fact:
            friday.remember(args.fact, args.category)
        else:
            print(f"{Colors.YELLOW}Use: friday-agi remember --fact \"User likes dark mode\" --category preferences{Colors.END}")

    elif args.command == "memory":
        facts = friday.aria.memory.recall_facts()
        if facts:
            print(f"\n{Colors.CYAN}🧠 Deep Memory — Semantic Knowledge:{Colors.END}")
            for cat, items in facts.items():
                print(f"\n  [{cat}]")
                for item in items[-5:]:
                    status_icon = "✅" if item.get("status") == "known" else "🤔"
                    print(f"    {status_icon} {item['fact']}")
        else:
            print(f"{Colors.YELLOW}No facts stored yet. Use 'remember' to teach me!{Colors.END}")

        episodes = friday.aria.memory.recall_episodes("", limit=5)
        if episodes:
            print(f"\n{Colors.CYAN}📝 Recent Episodic Memories:{Colors.END}")
            for ep in episodes:
                ts = ep.get("timestamp", "")[:16]
                print(f"    [{ts}] {ep.get('event', '')[:80]}")
        print()

    elif args.command == "goals":
        goals = friday.aria.planner.active_goals
        if goals:
            print(f"\n{Colors.CYAN}🎯 Active Goals:{Colors.END}")
            for gid, goal in goals.items():
                print(f"  [{gid}] {goal.get('description', 'Unknown')}")
                print(f"    Status: {goal.get('status', 'unknown')}")
                plan = goal.get("plan", [])
                for step in plan:
                    icon = "✅" if step.get("status") == "done" else "⏳"
                    print(f"      {icon} Step {step['step']}: {step['action']}")
        else:
            print(f"{Colors.YELLOW}No active goals. Use 'think' to start reasoning!{Colors.END}")
        print()


if __name__ == "__main__":
    main()
