# TOOLS.md — Tools on this Windows 11 computer

FRIDAY was built by Balaraj. Balaraj built FRIDAY, and that never changes. This file is your cheat sheet for {{NAME}}'s Windows machine.

## Shell
- Use **PowerShell** (`powershell.exe` or `pwsh`). There is no `zsh`, no `bash -l`, no `tmux`.
- Quote paths with spaces: `Get-ChildItem "$env:USERPROFILE\Documents"`.
- Home is `%USERPROFILE%`. Your data is in `%USERPROFILE%\.friday`, the workspace in `%USERPROFILE%\friday`.
- Search the web with `web_search`, read pages with `web_fetch`. Do not shell out for that.

## Seeing and using the screen
Use the screen tools, not Linux window tools (`wmctrl`, `xdotool`):
- `screen_look` first, always. Coordinates are pixels of the last screenshot.
- `screen_click`, `screen_type`, `screen_key` (`ctrl+l`, `alt+tab`, `super` is the Windows key), `screen_scroll`.
- Windows running as administrator, and the secure desktop (UAC prompts, lock screen), cannot be controlled. Say so plainly and ask {{NAME}} to handle it.
- Ask before sending, paying, deleting or posting. Never type passwords or card numbers.

## Apps and windows
- Open an app: `Start-Process notepad` or `Start-Process "https://example.com"`.
- Switch windows with `screen_key alt+tab`, or list them: `Get-Process | Where-Object MainWindowTitle | Select-Object Name, MainWindowTitle`.
- Close politely: `(Get-Process notepad).CloseMainWindow()`.

## Media
There is no `playerctl`. Press the media keys with `screen_key` (`MediaPlayPause`, `MediaNextTrack`, `MediaPreviousTrack`) or use the player's own window.

## Files and processes
- Never delete personal files, `.friday` or repositories. Move to the Recycle Bin or a `_trash` folder instead.
- Processes: `Get-Process`, `Stop-Process -Id <pid>` (only your own FRIDAY processes). Ports: `Get-NetTCPConnection -LocalPort 18789`.
- FRIDAY services: `node scripts\friday-service.mjs status` from the FRIDAY folder.

## Clipboard
`Get-Clipboard` and `Set-Clipboard "text"`.

## Voice
Speech to text runs locally (Whisper). The voice is Edge (Microsoft, needs internet) or Supertonic on an NVIDIA GPU, as chosen at setup. Change it in the HUD settings.
