import {execFileSync, spawn} from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {WebSocketServer} from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'test-token';

let dir;
let wss;
let port;
let daemon;
let sock;
let received;
let chatBehaviour;

function startFakeGateway() {
  return new Promise((resolve) => {
    wss = new WebSocketServer({port: 0, host: '127.0.0.1'}, () => resolve(wss.address().port));
    wss.on('connection', (ws) => {
      ws.send(JSON.stringify({type: 'event', event: 'connect.challenge', payload: {nonce: 'n'}}));
      ws.on('message', (raw) => {
        const f = JSON.parse(raw.toString());
        if (f.method === 'connect') {
          const ok = f.params?.auth?.token === TOKEN && f.params?.maxProtocol === 3;
          ws.send(JSON.stringify(ok ? {type: 'res', id: f.id, ok: true, payload: {type: 'hello-ok', protocol: 3}} : {type: 'res', id: f.id, ok: false, error: {code: 'UNAUTHORIZED', message: 'bad token'}}));
        } else if (f.method === 'chat.send') {
          received.push(f.params);
          ws.send(JSON.stringify({type: 'res', id: f.id, ok: true, payload: {runId: f.params.idempotencyKey, status: 'started'}}));
          const runId = f.params.idempotencyKey;
          const chat = (state, extra) => ws.send(JSON.stringify({type: 'event', event: 'chat', payload: {runId, sessionKey: f.params.sessionKey, seq: 1, state, ...extra}}));
          const msg = (text) => ({message: {role: 'assistant', content: [{type: 'text', text}]}});
          setTimeout(() => {
            if (chatBehaviour === 'error') return chat('error', {errorMessage: 'model unavailable'});
            chat('delta', msg('Your build failed.'));
            chat('delta', msg('Your build failed because of a missing import.\n\nDetails: line 12.'));
            chat('final', msg('Your build failed because of a missing import.\n\nDetails: line 12.'));
          }, 20);
        } else if (f.method === 'chat.abort') {
          ws.send(JSON.stringify({type: 'res', id: f.id, ok: true, payload: {ok: true}}));
        }
      });
    });
  });
}

function connectSocket(file) {
  return new Promise((resolve, reject) => {
    const events = [];
    const waiters = [];
    const s = net.connect(file);
    let buf = '';
    s.setEncoding('utf8');
    s.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const ev = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        events.push(ev);
        for (const w of waiters.slice()) if (w.match(ev)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(ev);
        }
      }
    });
    s.once('connect', () =>
      resolve({
        events,
        send: (o) => s.write(`${JSON.stringify(o)}\n`),
        next: (match, ms = 8000) =>
          new Promise((res, rej) => {
            const found = events.find(match);
            if (found) return res(found);
            const w = {match, resolve: res};
            waiters.push(w);
            setTimeout(() => rej(new Error(`timed out; got ${JSON.stringify(events)}`)), ms);
          }),
        close: () => s.destroy(),
      }),
    );
    s.once('error', reject);
  });
}

async function waitForSocket(file) {
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(file)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('daemon socket did not appear');
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-test-'));
  port = await startFakeGateway();
  received = [];
  sock = path.join(dir, 'qb.sock');
  daemon = spawn('node', [path.join(here, 'daemon.mjs')], {
    stdio: 'ignore',
    env: {
      ...process.env,
      XDG_RUNTIME_DIR: dir,
      FRIDAY_QUICKBAR_SOCKET: sock,
      FRIDAY_GATEWAY_PORT: String(port),
      FRIDAY_GATEWAY_TOKEN: TOKEN,
      FRIDAY_QUICKBAR_SPEAK: '0',
      FRIDAY_QUICKBAR_NO_WARM: '1',
    },
  });
  await waitForSocket(sock);
});

afterAll(() => {
  daemon?.kill('SIGTERM');
  wss?.close();
  fs.rmSync(dir, {recursive: true, force: true});
});

describe('quick bar daemon', () => {
  it('sends the question with the screenshot, streams the answer, and does not resend the picture', async () => {
    const png = path.join(dir, 'shot.png');
    execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=1', '-frames:v', '1', png]);
    const c = await connectSocket(sock);
    c.send({op: 'summon', shot: png});
    c.send({op: 'ask', text: 'why did my build fail?'});
    const fin = await c.next((e) => e.ev === 'final');
    expect(fin.text).toContain('missing import');
    expect(c.events.some((e) => e.ev === 'delta')).toBe(true);

    expect(received).toHaveLength(1);
    expect(received[0].sessionKey).toBe('agent:main:quickbar');
    expect(received[0].message.startsWith('why did my build fail?')).toBe(true);
    expect(received[0].deliver).toBe(false);
    const att = received[0].attachments;
    expect(att).toHaveLength(1);
    expect(att[0].mimeType).toBe('image/jpeg');
    expect(Buffer.from(att[0].content, 'base64').length).toBeLessThan(380_000);
    expect(JSON.stringify(received[0]).length).toBeLessThan(500_000);

    c.send({op: 'ask', text: 'and how do I fix it?'});
    await c.next((e) => e.ev === 'final' && c.events.filter((x) => x.ev === 'final').length === 2);
    expect(received).toHaveLength(2);
    expect(received[1].attachments).toBeUndefined();
    c.close();
  });

  it('attaches the new screenshot after a new summon', async () => {
    const png = path.join(dir, 'shot2.png');
    execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=1', '-frames:v', '1', png]);
    const before = received.length;
    const c = await connectSocket(sock);
    c.send({op: 'summon', shot: png});
    c.send({op: 'ask', text: 'what is this?'});
    await c.next((e) => e.ev === 'final');
    expect(received.length).toBe(before + 1);
    expect(received[before].attachments).toHaveLength(1);
    c.close();
  });

  it('reports a model error to the bar', async () => {
    chatBehaviour = 'error';
    const c = await connectSocket(sock);
    c.send({op: 'summon'});
    c.send({op: 'ask', text: 'hello'});
    const err = await c.next((e) => e.ev === 'error');
    expect(err.message).toContain('model unavailable');
    chatBehaviour = undefined;
    c.close();
  });

  it('answers ping', async () => {
    const c = await connectSocket(sock);
    c.send({op: 'ping'});
    await c.next((e) => e.ev === 'pong');
    c.close();
  });
});
