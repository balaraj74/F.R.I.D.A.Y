# FRIDAY Quick Bar host for Windows

Tray-only Electron app, no main window. Same behaviour as the GNOME extension: four mouse shakes or
Ctrl+Alt+Space open a glass bar below-right of the pointer, after a screenshot of every monitor.

- Run: `electron quickbar/windows` (the supervisor does this, hidden) or `npm start` in this folder.
- Reused unchanged: `extension/shake.js`, `extension/glow.js`, `daemon/gateway-client.mjs`,
  `daemon/speak-text.mjs`, `daemon/services.mjs` (port checks), `daemon/voice.mjs` (voice settings).
- Pure logic with vitest tests is in `lib/*.mjs`; `main.mjs` only wires Electron to it.
- Voice follows `~/.friday/setup.json` (`edge` | `supertonic-gpu` | `none`); `~/.friday/quickbar.json`
  may set `speak:false` or `shortcut`. Set `FRIDAY_QUICKBAR_MATERIAL=none` to turn acrylic off.
- Control_Indicator: pill shown while `~/.friday/run/control.json` has `active:true`. Ctrl+Alt+Backspace
  or its Stop button writes `~/.friday/run/stop`.
- Tray: Open quick bar, Pause shake, Quit (until next logon; exits with code 0).
