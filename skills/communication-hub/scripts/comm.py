#!/usr/bin/env python3
"""
💬 FRIDAY Communication Hub
===========================
Centralized messaging: WhatsApp, Email, Notifications

Usage:
    python comm.py whatsapp send <name> <message>
    python comm.py whatsapp read [count]
    python comm.py whatsapp unread
    python comm.py email read [count]
    python comm.py email send <to> <subject> <body>
    python comm.py notify <title> <message>
"""

import subprocess
import json
import sys
import os
import re
from pathlib import Path
from datetime import datetime
import requests

# Paths
FRIDAY_DIR = Path.home() / ".friday"
COMM_CACHE = FRIDAY_DIR / "cache" / "communication"
COMM_CACHE.mkdir(parents=True, exist_ok=True)


def run_adb(cmd, timeout=30):
    """Run ADB command."""
    try:
        result = subprocess.run(
            ["adb"] + cmd,
            capture_output=True,
            text=True,
            timeout=timeout
        )
        return result.stdout.strip(), result.returncode == 0
    except:
        return "", False


# ============ WHATSAPP ============
class WhatsAppController:
    """Control WhatsApp via ADB and FRIDAY gateway."""
    
    def __init__(self):
        self.gateway_url = "http://localhost:7777"
    
    def send_message(self, name, message):
        """Send WhatsApp message."""
        # Try via FRIDAY gateway first (if WhatsApp is connected)
        try:
            response = requests.post(
                f"{self.gateway_url}/api/whatsapp/send",
                json={"to": name, "message": message},
                timeout=10
            )
            if response.status_code == 200:
                print(f"✅ WhatsApp to {name}: {message}")
                return True
        except:
            pass
        
        # Fallback: Open WhatsApp with pre-filled message on phone
        # Format phone number or use contact name
        encoded_msg = message.replace(" ", "%20")
        
        # If name is a contact, search for it
        contacts = self._get_contacts()
        phone = None
        for c in contacts:
            if name.lower() in c.get("name", "").lower():
                phone = c.get("number", "").replace(" ", "").replace("-", "")
                break
        
        if phone:
            # Open WhatsApp with this number
            cmd = [
                "shell", "am", "start", "-a", "android.intent.action.VIEW",
                "-d", f"https://wa.me/{phone}?text={encoded_msg}"
            ]
            output, success = run_adb(cmd)
            if success:
                print(f"✅ Opening WhatsApp chat with {name}")
                return True
        
        print(f"❌ Could not find {name} in WhatsApp")
        return False
    
    def _get_contacts(self):
        """Get contacts from cache."""
        contacts_file = FRIDAY_DIR / "devices" / "contacts.json"
        if contacts_file.exists():
            try:
                with open(contacts_file) as f:
                    data = json.load(f)
                    return data.get("contacts", [])
            except:
                pass
        return []
    
    def read_messages(self, count=5):
        """Read recent WhatsApp messages via FRIDAY gateway."""
        try:
            response = requests.get(
                f"{self.gateway_url}/api/whatsapp/messages?limit={count}",
                timeout=10
            )
            if response.status_code == 200:
                messages = response.json().get("messages", [])
                return messages
        except:
            pass
        
        print("⚠ WhatsApp not connected to FRIDAY gateway")
        return []
    
    def get_unread(self):
        """Get unread message count."""
        try:
            response = requests.get(
                f"{self.gateway_url}/api/whatsapp/unread",
                timeout=10
            )
            if response.status_code == 200:
                return response.json().get("count", 0)
        except:
            pass
        return 0


# ============ NOTIFICATIONS ============
class NotificationController:
    """Desktop notifications."""
    
    def notify(self, title, message, urgency="normal"):
        """Send desktop notification."""
        try:
            subprocess.run([
                "notify-send",
                "-u", urgency,
                "-a", "FRIDAY",
                "-i", "dialog-information",
                title,
                message
            ], timeout=5)
            print(f"📢 Notification: {title}")
            return True
        except:
            return False
    
    def sync_phone_notifications(self):
        """Sync notifications from phone."""
        # Read notifications via ADB
        cmd = ["shell", "dumpsys", "notification", "--noredact"]
        output, success = run_adb(cmd)
        
        notifications = []
        if success and output:
            # Parse notification dump
            current_pkg = None
            current_text = None
            
            for line in output.split("\n"):
                if "pkg=" in line:
                    match = re.search(r'pkg=(\S+)', line)
                    if match:
                        current_pkg = match.group(1)
                if "android.text=" in line:
                    match = re.search(r'android.text=(.+)', line)
                    if match:
                        current_text = match.group(1)
                        notifications.append({
                            "app": current_pkg,
                            "text": current_text,
                            "time": datetime.now().isoformat()
                        })
        
        return notifications


# ============ EMAIL (Basic) ============
class EmailController:
    """Basic email via system mail or web."""
    
    def open_gmail(self):
        """Open Gmail in browser."""
        subprocess.Popen(
            ["xdg-open", "https://mail.google.com"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        print("📧 Opening Gmail...")
        return True
    
    def compose_email(self, to, subject, body):
        """Open email composer."""
        subject_encoded = subject.replace(" ", "%20")
        body_encoded = body.replace(" ", "%20")
        
        url = f"https://mail.google.com/mail/?view=cm&to={to}&su={subject_encoded}&body={body_encoded}"
        subprocess.Popen(
            ["xdg-open", url],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        print(f"📧 Composing email to {to}...")
        return True


# ============ CLI ============
def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    
    service = sys.argv[1].lower()
    
    if service == "whatsapp":
        wa = WhatsAppController()
        
        if len(sys.argv) < 3:
            print("Usage: comm.py whatsapp <send|read|unread>")
            return
        
        action = sys.argv[2].lower()
        
        if action == "send" and len(sys.argv) >= 5:
            name = sys.argv[3]
            message = " ".join(sys.argv[4:])
            wa.send_message(name, message)
        
        elif action == "read":
            count = int(sys.argv[3]) if len(sys.argv) > 3 else 5
            messages = wa.read_messages(count)
            if messages:
                print(f"📱 Last {len(messages)} WhatsApp messages:")
                for m in messages:
                    print(f"  {m.get('from', 'Unknown')}: {m.get('text', '')}")
            else:
                print("No messages found")
        
        elif action == "unread":
            count = wa.get_unread()
            print(f"📱 {count} unread WhatsApp messages")
    
    elif service == "notify":
        notif = NotificationController()
        if len(sys.argv) >= 4:
            title = sys.argv[2]
            message = " ".join(sys.argv[3:])
            notif.notify(title, message)
    
    elif service == "email":
        email = EmailController()
        
        if len(sys.argv) < 3:
            email.open_gmail()
            return
        
        action = sys.argv[2].lower()
        
        if action == "read":
            email.open_gmail()
        
        elif action == "send" and len(sys.argv) >= 6:
            to = sys.argv[3]
            subject = sys.argv[4]
            body = " ".join(sys.argv[5:])
            email.compose_email(to, subject, body)
    
    elif service == "phone-notify":
        notif = NotificationController()
        notifications = notif.sync_phone_notifications()
        print(f"📱 {len(notifications)} phone notifications:")
        for n in notifications[:10]:
            print(f"  [{n.get('app', 'Unknown')}] {n.get('text', '')}")
    
    else:
        print(f"Unknown service: {service}")
        print(__doc__)


if __name__ == "__main__":
    main()
