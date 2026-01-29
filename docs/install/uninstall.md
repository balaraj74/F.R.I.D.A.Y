---
summary: "Uninstall FRIDAY completely (CLI, service, state, workspace)"
read_when:
  - You want to remove FRIDAY from a machine
  - The gateway service is still running after uninstall
---

# Uninstall

Two paths:
- **Easy path** if `friday` is still installed.
- **Manual service removal** if the CLI is gone but the service is still running.

## Easy path (CLI still installed)

Recommended: use the built-in uninstaller:

```bash
friday uninstall
```

Non-interactive (automation / npx):

```bash
friday uninstall --all --yes --non-interactive
npx -y friday uninstall --all --yes --non-interactive
```

Manual steps (same result):

1) Stop the gateway service:

```bash
friday gateway stop
```

2) Uninstall the gateway service (launchd/systemd/schtasks):

```bash
friday gateway uninstall
```

3) Delete state + config:

```bash
rm -rf "${FRIDAY_STATE_DIR:-$HOME/.friday}"
```

If you set `FRIDAY_CONFIG_PATH` to a custom location outside the state dir, delete that file too.

4) Delete your workspace (optional, removes agent files):

```bash
rm -rf ~/friday
```

5) Remove the CLI install (pick the one you used):

```bash
npm rm -g friday
pnpm remove -g friday
bun remove -g friday
```

6) If you installed the macOS app:

```bash
rm -rf /Applications/FRIDAY.app
```

Notes:
- If you used profiles (`--profile` / `FRIDAY_PROFILE`), repeat step 3 for each state dir (defaults are `~/.friday-<profile>`).
- In remote mode, the state dir lives on the **gateway host**, so run steps 1-4 there too.

## Manual service removal (CLI not installed)

Use this if the gateway service keeps running but `friday` is missing.

### macOS (launchd)

Default label is `bot.molt.gateway` (or `bot.molt.<profile>`; legacy `com.friday.*` may still exist):

```bash
launchctl bootout gui/$UID/bot.molt.gateway
rm -f ~/Library/LaunchAgents/bot.molt.gateway.plist
```

If you used a profile, replace the label and plist name with `bot.molt.<profile>`. Remove any legacy `com.friday.*` plists if present.

### Linux (systemd user unit)

Default unit name is `friday-gateway.service` (or `friday-gateway-<profile>.service`):

```bash
systemctl --user disable --now friday-gateway.service
rm -f ~/.config/systemd/user/friday-gateway.service
systemctl --user daemon-reload
```

### Windows (Scheduled Task)

Default task name is `FRIDAY Gateway` (or `FRIDAY Gateway (<profile>)`).
The task script lives under your state dir.

```powershell
schtasks /Delete /F /TN "FRIDAY Gateway"
Remove-Item -Force "$env:USERPROFILE\.friday\gateway.cmd"
```

If you used a profile, delete the matching task name and `~\.friday-<profile>\gateway.cmd`.

## Normal install vs source checkout

### Normal install (install.sh / npm / pnpm / bun)

If you used `https://friday.ai/install.sh` or `install.ps1`, the CLI was installed with `npm install -g friday@latest`.
Remove it with `npm rm -g friday` (or `pnpm remove -g` / `bun remove -g` if you installed that way).

### Source checkout (git clone)

If you run from a repo checkout (`git clone` + `friday ...` / `bun run friday ...`):

1) Uninstall the gateway service **before** deleting the repo (use the easy path above or manual service removal).
2) Delete the repo directory.
3) Remove state + workspace as shown above.
