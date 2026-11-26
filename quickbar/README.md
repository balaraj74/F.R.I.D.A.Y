# FRIDAY Quick Bar

Shake the mouse, or hold **F + Space**, or press **Ctrl+Alt+Space**. FRIDAY takes a picture of your
screen, opens a small bar next to the cursor, and answers your question about what you see. Type
it or press the mic button (Ctrl+M). The answer streams in and the first lines are spoken aloud.

## How it works

```
GNOME Shell extension (extension/)        daemon (daemon/, Node, started on demand)
  watches pointer + keys                     gateway WebSocket (chat.send + screenshot)
  grabs the screen before the bar opens ---> shrinks the picture (ffmpeg), deletes the original
  shows the bar at the cursor  <-----------  streams the answer; speaks the lead paragraph
  Unix socket, one JSON object per line      starts gateway / voice servers if the HUD is closed
```

- **Why an extension:** on GNOME Wayland an ordinary app cannot read the global pointer, place a
  window at the cursor or take a silent screenshot. The extension can, and it costs nothing while idle.
- **Why a daemon:** gateway, microphone and voice work stay out of the shell process, so a bug there
  cannot freeze your desktop. It starts on the first summon and exits after 30 idle minutes.
- **Voice:** whisper.cpp for speech to text and Supertonic for speech, the same engines as the HUD.
  If the HUD is open they are reused, otherwise the daemon starts its own copies on separate ports.
- **Chat history:** questions go to the session `agent:main:quickbar`, apart from your main chat.

## Install

`quickbar/install.sh` (the main `install.sh` runs it on GNOME). Log out and in once afterwards;
Wayland cannot load a new extension live. Remove it with `quickbar/install.sh --uninstall`.

## Settings

```
gsettings --schemadir quickbar/extension/schemas set org.gnome.shell.extensions.friday-quickbar shake-enabled false
gsettings --schemadir quickbar/extension/schemas set org.gnome.shell.extensions.friday-quickbar chord-enabled false
gsettings --schemadir quickbar/extension/schemas set org.gnome.shell.extensions.friday-quickbar summon-shortcut "['<Super>y']"
```

`~/.friday/quickbar.json` can set `"speak": false` to turn off the spoken answer.

## The F + Space chord

A chord cannot be intercepted before the letter is typed, so one `f` and one space can reach the app
you are in. The chord only counts when both keys are held together for about 110 ms, so normal typing
("if ", "of ") does not trigger it. Turn it off with `chord-enabled false` if it ever gets in the way;
Ctrl+Alt+Space has no side effects.

## Debugging

```
journalctl -f -o cat /usr/bin/gnome-shell | grep -i quickbar     # extension messages
gnome-extensions info friday-quickbar@friday.balaraj74            # state and errors
node quickbar/daemon/daemon.mjs                                   # run the daemon in a terminal
```

Tests: `npx vitest run quickbar`.
