// Voice control for the HUD main process:
//  - runs the offline wake-word / live-transcript sidecar (voice/friday_wake.py)
//  - listens on a private Unix socket so a desktop-wide shortcut can trigger push-to-talk
//    (Electron globalShortcut is unreliable under GNOME Wayland; a GNOME custom
//    keybinding running `friday-hud/voice/ptt.sh` works everywhere)
//  - forwards everything to the renderer as `voice:command` events

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const VENV_PY = path.join(os.homedir(), '.friday', 'voice-venv', 'bin', 'python');
const WAKE_SCRIPT = path.join(__dirname, '..', 'voice', 'friday_wake.py');
const SOCKET_PATH = path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), 'friday-hud.sock');
const RESTART_DELAY_MS = 5000;

function createVoiceControl({ getWindow, ipcMain }) {
  let sidecar = null;
  let stopped = false;
  let mode = 'wake';
  let server = null;

  const send = (cmd) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('voice:command', cmd);
  };

  const setMode = (next) => {
    mode = next;
    if (sidecar && sidecar.stdin.writable) sidecar.stdin.write(`${next}\n`);
  };

  function startSidecar() {
    if (stopped) return;
    if (!fs.existsSync(VENV_PY)) {
      console.warn('[VOICE] Wake word disabled: run friday-hud/voice/setup.sh');
      return;
    }
    sidecar = spawn(VENV_PY, [WAKE_SCRIPT], { stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '';
    sidecar.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'ready') sidecar.stdin.write(`${mode}\n`);
          else if (msg.type === 'error') console.warn('[VOICE] sidecar:', msg.message);
          else send(msg);
        } catch {
          // ignore non-JSON noise
        }
      }
    });
    sidecar.on('exit', () => {
      sidecar = null;
      if (!stopped) setTimeout(startSidecar, RESTART_DELAY_MS);
    });
  }

  function startSocket() {
    try { fs.unlinkSync(SOCKET_PATH); } catch {}
    server = net.createServer((conn) => {
      conn.setEncoding('utf8');
      conn.on('data', (data) => {
        const cmd = String(data).trim();
        if (cmd === 'ptt' || cmd === 'cancel') send({ type: cmd });
        conn.end();
      });
      conn.on('error', () => {});
    });
    server.on('error', (e) => console.warn('[VOICE] control socket:', e.message));
    server.listen(SOCKET_PATH, () => {
      // Only this user may trigger the HUD.
      try { fs.chmodSync(SOCKET_PATH, 0o600); } catch {}
    });
  }

  // The renderer reports what FRIDAY is doing; the sidecar follows:
  // listening -> live transcript, speaking -> paused (so she can't wake herself), else wake word.
  ipcMain.on('voice:state', (_event, { listening, speaking } = {}) => {
    setMode(listening ? 'transcribe' : speaking ? 'pause' : 'wake');
  });

  startSidecar();
  startSocket();

  return {
    socketPath: SOCKET_PATH,
    dispose() {
      stopped = true;
      if (sidecar) sidecar.kill();
      if (server) server.close();
      try { fs.unlinkSync(SOCKET_PATH); } catch {}
    },
  };
}

module.exports = { createVoiceControl };
