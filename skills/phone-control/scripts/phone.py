#!/usr/bin/env python3
"""
📱 FRIDAY Phone Control
======================
Control Android phone: contacts, calls, SMS, TTS

Usage:
    python phone.py contacts [search]    - List/search contacts
    python phone.py call <name/number>   - Make a call
    python phone.py sms <name> <message> - Send SMS
    python phone.py speak <message>      - Speak via phone TTS
    python phone.py answer               - Answer incoming call
    python phone.py hangup               - End call
    python phone.py status               - Phone status
"""

import subprocess
import json
import sys
import os
import re
from pathlib import Path
from difflib import SequenceMatcher

# Paths
FRIDAY_DIR = Path.home() / ".friday"
CONTACTS_CACHE = FRIDAY_DIR / "devices" / "contacts.json"
PHONE_CONFIG = FRIDAY_DIR / "devices" / "phone.json"


def run_adb(cmd, timeout=30):
    """Run ADB command and return output."""
    try:
        result = subprocess.run(
            ["adb"] + cmd,
            capture_output=True,
            text=True,
            timeout=timeout
        )
        return result.stdout.strip(), result.returncode == 0
    except subprocess.TimeoutExpired:
        return "Timeout", False
    except Exception as e:
        return str(e), False


def is_phone_connected():
    """Check if phone is connected via ADB."""
    output, success = run_adb(["devices"])
    if success:
        lines = output.strip().split("\n")
        for line in lines[1:]:  # Skip header
            if "device" in line and "unauthorized" not in line:
                return True
    return False


def get_contacts(force_refresh=False):
    """Get contacts from phone (cached)."""
    # Check cache first
    if not force_refresh and CONTACTS_CACHE.exists():
        try:
            with open(CONTACTS_CACHE) as f:
                data = json.load(f)
                if data.get("contacts"):
                    return data["contacts"]
        except:
            pass
    
    # Fetch from phone
    print("📱 Fetching contacts from phone...")
    
    # Use content provider to get contacts
    cmd = [
        "shell", "content", "query", 
        "--uri", "content://contacts/phones",
        "--projection", "display_name:number"
    ]
    output, success = run_adb(cmd)
    
    if not success:
        # Try alternative method
        cmd = [
            "shell", "content", "query",
            "--uri", "content://com.android.contacts/data",
            "--projection", "display_name:data1",
            "--where", "mimetype='vnd.android.cursor.item/phone_v2'"
        ]
        output, success = run_adb(cmd)
    
    contacts = []
    
    if success and output:
        # Parse output
        for line in output.split("\n"):
            if "display_name=" in line:
                # Extract name and number
                name_match = re.search(r'display_name=([^,]+)', line)
                num_match = re.search(r'(?:number|data1)=([^,\n]+)', line)
                
                if name_match and num_match:
                    name = name_match.group(1).strip()
                    number = num_match.group(1).strip()
                    
                    if name and number and name != "NULL":
                        contacts.append({
                            "name": name,
                            "number": number
                        })
    
    # Remove duplicates
    seen = set()
    unique_contacts = []
    for c in contacts:
        key = (c["name"].lower(), c["number"])
        if key not in seen:
            seen.add(key)
            unique_contacts.append(c)
    
    # Save cache
    CONTACTS_CACHE.parent.mkdir(parents=True, exist_ok=True)
    with open(CONTACTS_CACHE, "w") as f:
        json.dump({"contacts": unique_contacts}, f, indent=2)
    
    print(f"✅ Found {len(unique_contacts)} contacts")
    return unique_contacts


def search_contacts(query):
    """Search contacts by name."""
    contacts = get_contacts()
    query_lower = query.lower()
    
    # Exact match first
    for c in contacts:
        if query_lower == c["name"].lower():
            return c
    
    # Partial match
    matches = []
    for c in contacts:
        if query_lower in c["name"].lower():
            matches.append(c)
    
    if matches:
        # Return best match
        return max(matches, key=lambda x: SequenceMatcher(None, query_lower, x["name"].lower()).ratio())
    
    # Fuzzy match
    best_match = None
    best_ratio = 0
    for c in contacts:
        ratio = SequenceMatcher(None, query_lower, c["name"].lower()).ratio()
        if ratio > best_ratio and ratio > 0.5:
            best_ratio = ratio
            best_match = c
    
    return best_match


def make_call(target):
    """Make a phone call."""
    # Check if it's a number or name
    if re.match(r'^[\d+\-\s()]+$', target):
        # It's a number
        number = re.sub(r'[\s\-()]', '', target)
    else:
        # Search contacts
        contact = search_contacts(target)
        if contact:
            number = contact["number"]
            print(f"📞 Calling {contact['name']} ({number})...")
        else:
            print(f"❌ Contact '{target}' not found")
            return False
    
    # Make call using ADB
    number = re.sub(r'[\s\-()]', '', number)
    
    # Try direct call first (requires permission)
    cmd = ["shell", "am", "start", "-a", "android.intent.action.CALL", "-d", f"tel:{number}"]
    output, success = run_adb(cmd)
    
    # If that fails or permission denied, try DIAL (opens dialer)
    if not success or "SecurityException" in output or "Error" in output:
        print("⚠ Direct call permission missing, opening dialer...")
        cmd = ["shell", "am", "start", "-a", "android.intent.action.DIAL", "-d", f"tel:{number}"]
        output, success = run_adb(cmd)
    
    if success:
        print(f"✅ Calling {number}...")
        return True
    else:
        print(f"❌ Failed to call: {output}")
        return False


def send_sms(target, message):
    """Send SMS message."""
    # Find contact
    if re.match(r'^[\d+\-\s()]+$', target):
        number = re.sub(r'[\s\-()]', '', target)
        name = number
    else:
        contact = search_contacts(target)
        if contact:
            number = contact["number"]
            name = contact["name"]
        else:
            print(f"❌ Contact '{target}' not found")
            return False
    
    # Send SMS using ADB
    number = re.sub(r'[\s\-()]', '', number)
    
    # Open SMS app with pre-filled message
    cmd = [
        "shell", "am", "start", 
        "-a", "android.intent.action.SENDTO",
        "-d", f"sms:{number}",
        "--es", "sms_body", message,
        "--ez", "exit_on_sent", "true"
    ]
    output, success = run_adb(cmd)
    
    if success:
        print(f"✅ SMS to {name}: {message}")
        
        # Try to auto-send (requires accessibility)
        # This opens the SMS app, user may need to press send
        print("   (Press send on your phone to confirm)")
        return True
    else:
        print(f"❌ Failed to send SMS: {output}")
        return False


def speak_on_phone(message):
    """Use phone's TTS to speak a message."""
    # Use Android's built-in TTS via broadcast
    
    # Method 1: Use am broadcast with TTS intent
    # This requires a TTS app that listens for broadcasts
    
    # Method 2: Use termux-tts-speak if Termux is installed
    cmd = ["shell", "am", "broadcast", 
           "-a", "com.termux.tts.speak",
           "--es", "text", message]
    output, success = run_adb(cmd)
    
    if not success:
        # Alternative: Use accessibility TTS
        cmd = ["shell", "settings", "put", "secure", "tts_default_synth", "com.google.android.tts"]
        run_adb(cmd)
        
        # Alternative: notification with TTS
        cmd = [
            "shell", "am", "start",
            "-a", "android.intent.action.MAIN",
            "-n", "com.google.android.googlequicksearchbox/com.google.android.voiceinteraction.VoiceInteractionActivity",
            "-e", "query", f"say {message}"
        ]
        output, success = run_adb(cmd)
    
    if success:
        print(f"🔊 Speaking: {message}")
        return True
    else:
        print(f"❌ TTS failed. Install Termux or enable Tasker for TTS support.")
        return False


def answer_call():
    """Answer incoming call."""
    # Method 1: Input keyevent
    cmd = ["shell", "input", "keyevent", "KEYCODE_CALL"]
    output, success = run_adb(cmd)
    
    if success:
        print("✅ Call answered")
        return True
    else:
        print(f"❌ Failed to answer: {output}")
        return False


def hangup_call():
    """End current call."""
    cmd = ["shell", "input", "keyevent", "KEYCODE_ENDCALL"]
    output, success = run_adb(cmd)
    
    if success:
        print("✅ Call ended")
        return True
    else:
        print(f"❌ Failed to hang up: {output}")
        return False


def phone_status():
    """Get phone status."""
    if not is_phone_connected():
        print("❌ Phone not connected")
        return
    
    print("📱 Phone Status")
    print("===============")
    
    # Get device info
    output, _ = run_adb(["shell", "getprop", "ro.product.model"])
    print(f"Model: {output}")
    
    output, _ = run_adb(["shell", "dumpsys", "battery", "|", "grep", "level"])
    if output:
        level = re.search(r'level:\s*(\d+)', output)
        if level:
            print(f"Battery: {level.group(1)}%")
    
    # Check call state
    output, _ = run_adb(["shell", "dumpsys", "telephony.registry", "|", "grep", "mCallState"])
    if output:
        if "mCallState=0" in output:
            print("Call: Idle")
        elif "mCallState=1" in output:
            print("Call: Ringing")
        elif "mCallState=2" in output:
            print("Call: In call")
    
    # Contacts count
    contacts = get_contacts()
    print(f"Contacts: {len(contacts)} cached")


def list_contacts(search=None):
    """List all contacts or search."""
    contacts = get_contacts()
    
    if search:
        search_lower = search.lower()
        contacts = [c for c in contacts if search_lower in c["name"].lower()]
    
    if not contacts:
        print("No contacts found")
        return
    
    print(f"📇 Contacts ({len(contacts)}):")
    print("-" * 40)
    for c in sorted(contacts, key=lambda x: x["name"].lower()):
        print(f"  {c['name']}: {c['number']}")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return
    
    command = sys.argv[1].lower()
    
    # Check phone connection for most commands
    if command not in ["help", "--help", "-h"]:
        if not is_phone_connected():
            print("❌ Phone not connected.")
            print("   Run: friday-phone connect")
            return
    
    if command == "contacts":
        search = sys.argv[2] if len(sys.argv) > 2 else None
        list_contacts(search)
    
    elif command == "call":
        if len(sys.argv) < 3:
            print("Usage: phone.py call <name or number>")
            return
        target = " ".join(sys.argv[2:])
        make_call(target)
    
    elif command == "sms":
        if len(sys.argv) < 4:
            print("Usage: phone.py sms <name> <message>")
            return
        target = sys.argv[2]
        message = " ".join(sys.argv[3:])
        send_sms(target, message)
    
    elif command == "speak":
        if len(sys.argv) < 3:
            print("Usage: phone.py speak <message>")
            return
        message = " ".join(sys.argv[2:])
        speak_on_phone(message)
    
    elif command == "answer":
        answer_call()
    
    elif command == "hangup" or command == "end":
        hangup_call()
    
    elif command == "status":
        phone_status()
    
    elif command == "refresh":
        get_contacts(force_refresh=True)
    
    else:
        print(f"Unknown command: {command}")
        print(__doc__)


if __name__ == "__main__":
    main()
