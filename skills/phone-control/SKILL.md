---
name: phone-control
version: 1.0.0
description: Control Android phone - contacts, calls, messages, and TTS
author: FRIDAY
---

# 📱 Phone Control Skill

This skill allows FRIDAY to control your Android phone via ADB for:
- Reading contacts
- Making phone calls
- Sending SMS
- Speaking through phone speaker (TTS)
- Answering/rejecting calls

## Requirements

- Android phone with USB debugging enabled
- ADB installed on the system
- Phone connected via USB or wireless ADB

## Commands

### Get Contacts
```bash
./scripts/phone.py contacts [search_term]
```

### Make a Call
```bash
./scripts/phone.py call [name_or_number]
```

### Send SMS
```bash
./scripts/phone.py sms [name_or_number] [message]
```

### Speak on Phone (TTS)
```bash
./scripts/phone.py speak [message]
```

### Answer Call
```bash
./scripts/phone.py answer
```

### End Call
```bash
./scripts/phone.py hangup
```

## Usage Examples

1. **"Call Mom"** - Finds Mom in contacts and calls
2. **"Text John: I'll be late"** - Sends SMS to John
3. **"Read my contacts"** - Lists all contacts
4. **"Speak Hello on phone"** - Uses phone's TTS to speak

## Notes

- Contacts are cached locally for faster access
- Phone must be connected before using these commands
- For wireless ADB, ensure phone is on the same network
