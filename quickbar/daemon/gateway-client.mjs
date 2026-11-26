// Minimal FRIDAY gateway client: connect, send a chat message with an optional picture, and
// stream the answer. Mirrors what the HUD does (friday-hud/src/services/gateway-ws.ts).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {stripReplyTags} from './speak-text.mjs';

const PROTOCOL = 3;
const REQUEST_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 10_000;

/** Port and token from the user's FRIDAY config. The token is only ever sent to the local gateway. */
export function readGatewayConfig(file = path.join(os.homedir(), '.friday', 'friday.json')) {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // Unreadable config: fall back to defaults; the gateway will refuse a missing token.
  }
  const port = Number(process.env.FRIDAY_GATEWAY_PORT) || cfg?.gateway?.port || 18789;
  const token = process.env.FRIDAY_GATEWAY_TOKEN || cfg?.gateway?.auth?.token || '';
  return {port, token};
}

/** Joins the text parts of a chat message payload. */
export function messageText(message) {
  const parts = Array.isArray(message?.content) ? message.content : [];
  return parts
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');
}

export class GatewayClient {
  constructor({port, token, WebSocketImpl = globalThis.WebSocket} = {}) {
    const cfg = port !== undefined && token !== undefined ? {} : readGatewayConfig();
    this.port = port ?? cfg.port;
    this.token = token ?? cfg.token;
    this.WebSocket = WebSocketImpl;
    this.ws = null;
    this.pending = new Map();
    this.runs = new Map();
    this.ready = null;
  }

  get connected() {
    return !!this.ws && this.ws.readyState === 1 && this._helloDone === true;
  }

  /** Opens the socket and completes the handshake. Safe to call repeatedly. */
  connect() {
    if (this.connected) return Promise.resolve();
    if (this.ready) return this.ready;
    this._helloDone = false;
    this.ready = new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          this.ready = null;
          try {
            this.ws?.close();
          } catch {
            // already closed
          }
          reject(err);
        } else resolve();
      };
      const timer = setTimeout(() => done(new Error('gateway handshake timed out')), CONNECT_TIMEOUT_MS);
      let ws;
      try {
        ws = new this.WebSocket(`ws://127.0.0.1:${this.port}`);
      } catch (err) {
        done(err);
        return;
      }
      this.ws = ws;
      ws.addEventListener('error', () => done(new Error('could not reach the gateway')));
      ws.addEventListener('close', () => {
        this._helloDone = false;
        this.ready = null;
        for (const [, p] of this.pending) p.reject(new Error('gateway connection closed'));
        this.pending.clear();
        for (const [, run] of this.runs) run.onError?.('The gateway connection closed.');
        this.runs.clear();
        done(new Error('gateway connection closed'));
      });
      ws.addEventListener('message', (ev) => {
        let frame;
        try {
          frame = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
        } catch {
          return;
        }
        this._onFrame(frame, done);
      });
    });
    return this.ready;
  }

  /** A gateway that is still starting accepts the socket but is slow to answer: try a few times. */
  async connectWithRetry(attempts = 4, pauseMs = 1500) {
    let lastError;
    for (let i = 0; i < attempts; i++) {
      try {
        return await this.connect();
      } catch (err) {
        lastError = err;
        await new Promise((r) => setTimeout(r, pauseMs));
      }
    }
    throw lastError;
  }

  _send(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  _sendConnect(done) {
    const id = `conn_${crypto.randomUUID().slice(0, 8)}`;
    this.pending.set(id, {
      resolve: () => {
        this._helloDone = true;
        done();
      },
      reject: (err) => done(err instanceof Error ? err : new Error(String(err))),
    });
    this._send({
      type: 'req',
      id,
      method: 'connect',
      params: {
        minProtocol: PROTOCOL,
        maxProtocol: PROTOCOL,
        client: {id: 'cli', version: '1.0.0', platform: 'linux', mode: 'cli', displayName: 'Quick bar'},
        role: 'operator',
        scopes: ['operator.admin', 'operator.approvals', 'operator.pairing'],
        auth: {token: this.token},
      },
    });
  }

  _onFrame(frame, done) {
    if (frame.type === 'event') {
      if (frame.event === 'connect.challenge') this._sendConnect(done);
      else if (frame.event === 'chat') this._onChat(frame.payload ?? {});
      return;
    }
    if (frame.type === 'res') {
      const p = this.pending.get(frame.id);
      if (!p) return;
      this.pending.delete(frame.id);
      if (frame.ok) p.resolve(frame.payload);
      else p.reject(new Error(frame.error?.message || frame.error?.code || 'request failed'));
    }
  }

  _onChat(payload) {
    const run = this.runs.get(payload.runId);
    if (!run) return;
    const text = stripReplyTags(messageText(payload.message));
    if (payload.state === 'delta') {
      run.text = text;
      run.onDelta?.(text);
    } else if (payload.state === 'final') {
      this.runs.delete(payload.runId);
      run.onFinal?.(text || run.text || '');
    } else if (payload.state === 'error') {
      this.runs.delete(payload.runId);
      run.onError?.(payload.errorMessage || 'FRIDAY ran into a problem answering that.');
    } else if (payload.state === 'aborted') {
      this.runs.delete(payload.runId);
      run.onFinal?.(run.text || '');
    }
  }

  request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) return reject(new Error('not connected to the gateway'));
      const id = `req_${crypto.randomUUID().slice(0, 8)}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this._send({type: 'req', id, method, params});
    });
  }

  /**
   * Sends a chat message. `image` is {base64, mimeType} or null. Resolves with the runId once the
   * gateway accepted it; the answer arrives through the handlers.
   */
  async chat({sessionKey, message, image = null, onDelta, onFinal, onError}) {
    await this.connectWithRetry();
    const runId = `quick_${Date.now()}_${crypto.randomUUID().slice(0, 6)}`;
    this.runs.set(runId, {text: '', onDelta, onFinal, onError});
    const params = {sessionKey, message, deliver: false, idempotencyKey: runId};
    if (image) {
      params.attachments = [{type: 'image', mimeType: image.mimeType, fileName: 'screen.jpg', content: image.base64}];
    }
    try {
      await this.request('chat.send', params);
    } catch (err) {
      this.runs.delete(runId);
      throw err;
    }
    return runId;
  }

  async abort(sessionKey, runId) {
    try {
      await this.request('chat.abort', {sessionKey, runId}, 5000);
    } catch {
      // nothing to abort
    }
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      // already closed
    }
  }
}
