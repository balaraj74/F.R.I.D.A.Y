# Advanced AGI System

FRIDAY's advanced intelligence layer with memory, context awareness, and proactive capabilities.

## Capabilities

### 1. 🧠 Long-Term Memory
FRIDAY remembers important information about you across conversations.

**Memory File**: `~/.friday/memory.json`

```json
{
  "user_profile": {
    "name": "Balaraj",
    "preferences": {},
    "learned_patterns": []
  },
  "facts": [],
  "conversation_summaries": [],
  "reminders": []
}
```

### 2. 👁️ Context Awareness
FRIDAY knows what's happening on your system.

**Check running apps**:
```bash
wmctrl -l | awk '{$1=$2=$3=""; print substr($0,4)}' | head -20
```

**Get active window**:
```bash
xdotool getactivewindow getwindowname
```

**Check system status**:
```bash
# Battery
cat /sys/class/power_supply/BAT*/capacity 2>/dev/null || echo "No battery"

# CPU/Memory
free -h | grep Mem | awk '{print "Memory: "$3"/"$2}'

# Network
nmcli -t -f active,ssid dev wifi | grep '^yes' | cut -d: -f2
```

### 3. 🔄 Proactive Monitoring
Commands to check system health:

```bash
# Low battery warning (under 20%)
BAT=$(cat /sys/class/power_supply/BAT*/capacity 2>/dev/null)
[ "$BAT" -lt 20 ] && echo "Low battery: $BAT%"

# Disk space warning
df -h / | awk 'NR==2 {if (int($5) > 90) print "Disk almost full: "$5}'

# High memory usage
free | awk 'NR==2 {if ($3/$2*100 > 85) print "High memory usage"}'
```

### 4. 📱 Multi-Device Orchestration
Coordinate actions between laptop and phone.

**Sync clipboard to phone**:
```bash
xclip -selection clipboard -o | adb shell input text "$(cat)"
```

**Mirror phone notifications** (requires Termux on phone):
```bash
adb shell dumpsys notification --noredact | grep -A1 "ticker"
```

**Screenshot both devices**:
```bash
# Laptop
gnome-screenshot -f ~/Pictures/laptop_$(date +%s).png

# Phone  
adb shell screencap -p /sdcard/screen.png && adb pull /sdcard/screen.png ~/Pictures/phone_$(date +%s).png
```

### 5. 🎯 Smart Automations

**Morning routine**:
```bash
# Open work apps
google-chrome &
code ~/projects &
spotify &

# Check calendar/weather
curl -s "wttr.in?format=3"
```

**Night mode**:
```bash
# Reduce brightness
xrandr --output $(xrandr | grep " connected" | cut -d' ' -f1) --brightness 0.7

# Enable night light
gsettings set org.gnome.settings-daemon.plugins.color night-light-enabled true
```

**Focus mode**:
```bash
# Pause notifications
notify-send "Focus Mode" "Notifications paused for 1 hour"
gsettings set org.gnome.desktop.notifications show-banners false

# Pause phone notifications
adb shell settings put global heads_up_notifications_enabled 0
```

### 6. 🤖 Self-Improvement

**Update FRIDAY**:
```bash
cd ~/F.R.I.D.A.Y/F.R.I.D.A.Y
git pull origin main
pnpm install
pnpm build
systemctl --user restart friday-gateway
```

**Check FRIDAY health**:
```bash
systemctl --user status friday-gateway
journalctl --user -u friday-gateway -n 20 --no-pager
```

## Memory Commands

### Save a fact about user
```bash
echo '{"fact": "User prefers dark mode", "timestamp": "'$(date -Iseconds)'"}' >> ~/.friday/memory.json
```

### Add a reminder
```bash
echo '{"reminder": "Team meeting at 3pm", "time": "15:00", "date": "'$(date +%Y-%m-%d)'"}' >> ~/.friday/reminders.json
```

## Voice Commands Examples

| Say | Action |
|-----|--------|
| "What am I working on?" | Check active window & recent files |
| "Remember that I like..." | Store preference |
| "Morning routine" | Execute morning automation |
| "Focus mode" | Mute notifications, dim screen |
| "System status" | Check battery, memory, disk |
| "Sync to phone" | Share clipboard with phone |
| "Night mode" | Reduce brightness, warm colors |

## Integration Notes

FRIDAY uses the `exec` tool to run these commands. For complex operations, chain multiple commands:

```bash
# Smart response based on context
ACTIVE=$(xdotool getactivewindow getwindowname)
BATTERY=$(cat /sys/class/power_supply/BAT*/capacity 2>/dev/null || echo "100")
echo "Active: $ACTIVE, Battery: $BATTERY%"
```
