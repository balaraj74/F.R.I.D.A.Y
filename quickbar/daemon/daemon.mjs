#!/usr/bin/env node
// FRIDAY quick bar daemon. Started on demand by the GNOME extension, talks to it over a Unix
// socket with one JSON object per line, and exits after a long idle period.
//
//   extension -> daemon:  summon {shot}, ask {text}, mic {action: start|stop}, silence, abort, dismiss
//   daemon -> extension:  status {text}, delta {text}, final {text}, error {message},
//                         mic {state}, transcript {text}, speaking {on}
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {GatewayClient, readGatewayConfig} from './gateway-client.mjs';
import {Services} from './services.mjs';
import {leadParagraphIfComplete, pickSpoken} from './speak-text.mjs';
import {prepareScreenshot} from './shot.mjs';
import {Recorder, Speaker, transcribe} from './voice.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const runtimeDir = process.env.XDG_RUNTIME_DIR || os.tmpdir();
export const SOCKET_PATH = process.env.FRIDAY_QUICKBAR_SOCKET || path.join(runtimeDir, 'friday-quickbar.sock');
const WORK_DIR = path.join(runtimeDir, 'friday-quickbar');
const VOICE_IDLE_MS = 10 * 60_000;
const EXIT_IDLE_MS = 30 * 60_000;
const SESSION_KEY = 'agent:main:quickbar';

function readOwnConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.friday', 'quickbar.json'), 'utf8'));
  } catch {
    return {};
  }
}

const own = readOwnConfig();
const repoDir = own.repoDir || path.resolve(here, '..', '..');
const speakEnabled = process.env.FRIDAY_QUICKBAR_SPEAK ? process.env.FRIDAY_QUICKBAR_SPEAK !== '0' : own.speak !== false;
const gwCfg = readGatewayConfig();

fs.mkdirSync(WORK_DIR, {recursive: true, mode: 0o700});
const services = new Services({repoDir, gatewayPort: gwCfg.port});
const gateway = new GatewayClient(gwCfg);
const recorder = new Recorder(WORK_DIR);
const speaker = new Speaker(WORK_DIR);

let client = null;
let idleTimer = null;
let state = {shot: null, shotSent: false, runId: null, spoke: false};

const send = (obj) => {
  if (client && !client.destroyed) client.write(`${JSON.stringify(obj)}\n`);
};

// Resident mode (systemd service): never idle out, and keep the gateway link warm so the first
// question after a long pause is sent with no connection delay.
const resident = process.env.FRIDAY_QUICKBAR_RESIDENT === '1';

function keepGatewayWarm() {
  const tick = () => {
    if (!gateway.connected) gateway.connectWithRetry(2, 1000).catch(() => {});
  };
  tick();
  setInterval(tick, 10_000).unref();
}

function touch() {
  if (resident) return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    services.stopVoice();
    idleTimer = setTimeout(async () => {
      await services.stopAll({includeGateway: true});
      shutdown();
    }, EXIT_IDLE_MS - VOICE_IDLE_MS);
  }, VOICE_IDLE_MS);
}

const QUICK_NOTE =
  '[Quick bar: Sir summoned you from his desktop. Answer in a short spoken lead first: one or two plain sentences ' +
  'with no markdown, then a blank line, then any detail he may want to read.]';

async function onSummon(msg) {
  state = {shot: null, shotSent: false, runId: null, spoke: false};
  speaker.stop();
  if (msg.shot) {
    // The picture of Sir's screen is private: it is deleted as soon as it has been shrunk.
    state.shot = prepareScreenshot(msg.shot, WORK_DIR)
      .catch(() => null)
      .finally(() => fs.rm(msg.shot, {force: true}, () => {}));
  }
  // Warm everything while Sir is still typing. Failures here are not errors yet.
  services.ensureGateway((text) => send({ev: 'status', text})).then((r) => {
    if (!r.ok) send({ev: 'status', text: r.error});
    else gateway.connect().catch(() => {});
  });
  if (process.env.FRIDAY_QUICKBAR_NO_WARM === '1') return;
  if (speakEnabled) services.ensureTts().catch(() => {});
  services.ensureStt().catch(() => {});
}

async function onAsk(msg) {
  const text = String(msg.text ?? '').trim();
  if (!text) return;
  speaker.stop();
  if (state.runId) await gateway.abort(SESSION_KEY, state.runId);
  state.spoke = false;

  const up = await services.ensureGateway((t) => send({ev: 'status', text: t}));
  if (!up.ok) return send({ev: 'error', message: up.error});
  const image = state.shotSent ? null : await state.shot;
  const note = image ? `${QUICK_NOTE} A screenshot of his screen is attached.` : QUICK_NOTE;
  send({ev: 'status', text: 'Thinking...'});
  try {
    state.runId = await gateway.chat({
      sessionKey: SESSION_KEY,
      message: `${text}\n\n${note}`,
      image,
      onDelta: (answer) => {
        send({ev: 'delta', text: answer});
        if (speakEnabled && !state.spoke) {
          const lead = leadParagraphIfComplete(answer);
          if (lead) speak(lead);
        }
      },
      onFinal: (answer) => {
        state.runId = null;
        send({ev: 'final', text: answer});
        if (speakEnabled && !state.spoke) {
          const lead = pickSpoken(answer);
          if (lead) speak(lead);
        }
      },
      onError: (message) => {
        state.runId = null;
        send({ev: 'error', message});
      },
    });
    if (image) state.shotSent = true;
  } catch (err) {
    send({ev: 'error', message: String(err?.message ?? err)});
  }
}

function speak(text) {
  state.spoke = true;
  send({ev: 'speaking', on: true});
  speaker
    .say(text, () => services.ensureTts())
    .catch(() => {})
    .finally(() => send({ev: 'speaking', on: false}));
}

async function onMic(msg) {
  if (msg.action === 'start') {
    speaker.stop();
    recorder.start();
    send({ev: 'mic', state: 'recording'});
    services.ensureStt().catch(() => {});
    return;
  }
  const file = await recorder.stop();
  send({ev: 'mic', state: 'idle'});
  if (!file) return send({ev: 'transcript', text: ''});
  try {
    send({ev: 'status', text: 'Listening...'});
    const base = await services.ensureStt();
    if (!base) throw new Error('Speech recognition is not installed on this machine.');
    const text = await transcribe(base, file);
    send({ev: 'transcript', text});
  } catch (err) {
    send({ev: 'error', message: String(err?.message ?? err)});
  } finally {
    fs.rm(file, () => {});
  }
}

async function handle(msg) {
  touch();
  switch (msg.op) {
    case 'summon':
      return onSummon(msg);
    case 'ask':
      return onAsk(msg);
    case 'mic':
      return onMic(msg);
    case 'silence':
      return speaker.stop();
    case 'abort':
      speaker.stop();
      if (state.runId) await gateway.abort(SESSION_KEY, state.runId);
      return undefined;
    case 'dismiss':
      speaker.stop();
      await recorder.stop();
      return undefined;
    case 'ping':
      return send({ev: 'pong'});
    default:
      return undefined;
  }
}

const server = net.createServer((sock) => {
  client?.destroy();
  client = sock;
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      handle(msg).catch((err) => send({ev: 'error', message: String(err?.message ?? err)}));
    }
  });
  sock.on('close', () => {
    if (client === sock) client = null;
  });
  sock.on('error', () => {});
});

function shutdown() {
  speaker.stop();
  recorder.stop().catch(() => {});
  services.stopVoice();
  gateway.close();
  server.close();
  fs.rmSync(SOCKET_PATH, {force: true});
  process.exit(0);
}

async function main() {
  // A live daemon already owns the socket: leave it alone.
  if (fs.existsSync(SOCKET_PATH)) {
    const alive = await new Promise((resolve) => {
      const probe = net.connect(SOCKET_PATH);
      probe.once('connect', () => {
        probe.destroy();
        resolve(true);
      });
      probe.once('error', () => resolve(false));
    });
    if (alive) process.exit(0);
    fs.rmSync(SOCKET_PATH, {force: true});
  }
  server.listen(SOCKET_PATH, () => {
    fs.chmodSync(SOCKET_PATH, 0o600);
    touch();
    if (resident) {
      keepGatewayWarm();
      if (speakEnabled) services.ensureTts().catch(() => {});
    }
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('exit', () => services.stopVoice());
process.on('uncaughtException', (err) => {
  send({ev: 'error', message: String(err?.message ?? err)});
});

if (import.meta.url === `file://${process.argv[1]}`) main();
