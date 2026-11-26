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

## How the bar behaves

It is an overlay, not a dialog. It floats above your windows next to the pointer and nothing else is
blocked: you can click, scroll and type in the windows behind it. It stays open until you press Esc or
the close button. Click the bar to type in it; click a window and your typing goes there again.

The card is frosted glass (the background behind it is blurred) with a light that runs around its edge,
in Google's four colours. The light is slow while idle, fast while FRIDAY is thinking, and pulses while
she speaks.

## Always on (recommended)

`scripts/always-on.sh install` turns FRIDAY's engine into systemd user services: the reasoning proxy,
the gateway, speech to text, the voice (Supertonic on the GPU when CUDA is installed), this bar's helper
and the helper containers. They start at login, restart if they crash, and closing the HUD leaves them
running, so the bar answers straight from the gateway with no start-up wait and the voice is already loaded.

```
scripts/always-on.sh status      # what is running
scripts/always-on.sh uninstall   # back to "FRIDAY runs only while the HUD is open"
```

Speech to text (whisper.cpp) runs on the CPU in this build, about 1.3 s for a short question; the voice
runs on the GPU and speaks the first sentence in about 0.4 s. Idle cost is roughly 1 GB of GPU memory and
1.5 GB of RAM. Without always-on, the bar starts whatever is missing the first time you summon it.

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
