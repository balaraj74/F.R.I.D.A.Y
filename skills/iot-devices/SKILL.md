# IoT Device Control

Manage smart devices and custom hardware setups.

## Home Assistant Integration

### REST API
```bash
# Get entity state
curl -s -H "Authorization: Bearer $HA_TOKEN" \
  "http://homeassistant.local:8123/api/states/light.living_room"

# Turn on device
curl -X POST -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  "http://homeassistant.local:8123/api/services/light/turn_on" \
  -d '{"entity_id": "light.living_room", "brightness": 255}'

# Turn off device
curl -X POST -H "Authorization: Bearer $HA_TOKEN" \
  "http://homeassistant.local:8123/api/services/light/turn_off" \
  -d '{"entity_id": "light.living_room"}'

# Set thermostat
curl -X POST -H "Authorization: Bearer $HA_TOKEN" \
  "http://homeassistant.local:8123/api/services/climate/set_temperature" \
  -d '{"entity_id": "climate.thermostat", "temperature": 22}'

# Run automation
curl -X POST -H "Authorization: Bearer $HA_TOKEN" \
  "http://homeassistant.local:8123/api/services/automation/trigger" \
  -d '{"entity_id": "automation.good_morning"}'
```

## MQTT Control

### Publish/Subscribe
```bash
# Install mosquitto clients
sudo apt install -y mosquitto-clients

# Subscribe to topic
mosquitto_sub -h broker.local -t "home/sensors/#" -v

# Publish message
mosquitto_pub -h broker.local -t "home/lights/bedroom" -m '{"state": "ON"}'

# Publish with auth
mosquitto_pub -h broker.local -u user -P password -t "topic" -m "message"
```

## Raspberry Pi GPIO (via SSH)

### Control GPIO Pins
```bash
# SSH to Pi and control GPIO
ssh pi@raspberrypi.local "gpio -g write 17 1"  # Turn on GPIO 17
ssh pi@raspberrypi.local "gpio -g write 17 0"  # Turn off GPIO 17
ssh pi@raspberrypi.local "gpio -g read 18"     # Read GPIO 18

# Using Python on Pi
ssh pi@raspberrypi.local "python3 -c \"
import RPi.GPIO as GPIO
GPIO.setmode(GPIO.BCM)
GPIO.setup(17, GPIO.OUT)
GPIO.output(17, GPIO.HIGH)
\""
```

## Arduino/ESP32 (Serial)

### Serial Communication
```bash
# List serial devices
ls /dev/ttyUSB* /dev/ttyACM*

# Send command to Arduino
echo "LED_ON" > /dev/ttyUSB0

# Read from serial
cat /dev/ttyUSB0

# Interactive serial (screen)
screen /dev/ttyUSB0 9600

# Python serial
python3 -c "
import serial
ser = serial.Serial('/dev/ttyUSB0', 9600)
ser.write(b'LED_ON\n')
print(ser.readline())
"
```

## Smart Plugs (TP-Link Kasa)

### Using kasa CLI
```bash
# Install
pip install python-kasa

# Discover devices
kasa discover

# Turn on/off
kasa --host 192.168.1.100 on
kasa --host 192.168.1.100 off

# Get device info
kasa --host 192.168.1.100 state
```

## Philips Hue

### Hue API
```bash
# Get all lights
curl -s "http://hue-bridge/api/$HUE_USER/lights" | jq

# Turn on light
curl -X PUT "http://hue-bridge/api/$HUE_USER/lights/1/state" \
  -d '{"on": true, "bri": 254}'

# Set color (hue: 0-65535)
curl -X PUT "http://hue-bridge/api/$HUE_USER/lights/1/state" \
  -d '{"on": true, "hue": 25500, "sat": 254}'

# Create scene
curl -X PUT "http://hue-bridge/api/$HUE_USER/groups/0/action" \
  -d '{"scene": "scene-id"}'
```

## Network Device Discovery

```bash
# Scan local network for devices
nmap -sn 192.168.1.0/24

# Find specific device by MAC
arp -a | grep "aa:bb:cc"

# Check if device is online
ping -c 1 192.168.1.100 && echo "Online" || echo "Offline"
```

## Tools Required
- `mosquitto-clients` - MQTT
- `python-kasa` - TP-Link smart plugs
- `nmap` - Network scanning
- `screen` or `minicom` - Serial communication
- `python3-serial` - Python serial library

## Installation
```bash
sudo apt install -y mosquitto-clients nmap screen
pip install python-kasa pyserial
```
