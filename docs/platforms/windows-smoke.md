# Windows smoke check

Run on the friend's Windows 11 laptop after `install.ps1`. Tick each line and write down the numbers.

1. Install: one command finishes; setup screen opens; Coming soon models are greyed out.
2. Voice default: no NVIDIA GPU, so Edge voice is preselected. FRIDAY speaks a test line.
3. Reboot, do not open the HUD. `node scripts/friday-service.mjs status` shows proxy, gateway, whisper, quickbar running.
4. Shake the mouse 4 times with the HUD closed: quick bar opens below-right of the pointer. Time to open: ____ ms.
5. Ctrl+Alt+Space opens it too. Esc closes it.
6. Type a question: reply streams and speaks. Voice question: speech to text takes ____ s.
7. Ask "what is on my screen": screen_look works. Time: ____ s.
8. Ask FRIDAY to click and type in Notepad. The red/amber indicator shows. Ctrl+Alt+Backspace stops it.
9. Try an elevated window (Task Manager as admin): FRIDAY reports it cannot control it.
10. Idle for 10 minutes: quickbar CPU ____ % of one core, memory ____ MB (targets 2% and 200 MB). Acrylic glass visible; if opaque set FRIDAY_QUICKBAR_MATERIAL=none.
11. Quit from the tray: stays closed until next logon.
