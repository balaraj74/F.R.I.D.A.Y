import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeSocket {
  static instances: FakeSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 0;
  sent: any[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  push(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  /** Run the gateway handshake: challenge, then answer the connect request. */
  handshake() {
    this.open();
    this.push({ type: 'event', event: 'connect.challenge', payload: {} });
    const req = this.sent.find((r) => r.method === 'connect');
    this.push({ type: 'res', id: req.id, ok: true, payload: { snapshot: { uptimeMs: 1000 } } });
  }
}

const settle = () => vi.advanceTimersByTimeAsync(0);

async function freshClient() {
  vi.resetModules();
  const { FridayGatewayClient } = await import('./gateway-ws');
  return new FridayGatewayClient('ws://test', 'tok');
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('window', {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    addEventListener: () => {},
  });
  vi.stubGlobal('document', { hidden: false, addEventListener: () => {} });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('FridayGatewayClient connection', () => {
  it('replaces a socket that goes silent (laptop slept, half-open link) and reconnects', async () => {
    const c = await freshClient();
    c.connect();
    FakeSocket.instances[0].handshake();
    await settle();
    expect(c.connected).toBe(true);

    await vi.advanceTimersByTimeAsync(50_000); // no frames at all, and the health probe goes unanswered
    expect(c.connected).toBe(false);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(FakeSocket.instances.length).toBeGreaterThan(1); // a fresh socket was opened
  });

  it('rejects in-flight requests when the link dies instead of hanging forever', async () => {
    const c = await freshClient();
    c.connect();
    const ws = FakeSocket.instances[0];
    ws.handshake();
    const p = c.request('chat.history', {});
    const settled = p.then(
      () => 'ok',
      (e: Error) => e.message,
    );
    ws.onclose?.();
    expect(await settled).toMatch(/closed/);
  });

  it('times a request out when the gateway never answers', async () => {
    const c = await freshClient();
    c.connect();
    FakeSocket.instances[0].handshake();
    const settled = c.request('status', {}, undefined, 5_000).then(
      () => 'ok',
      (e: Error) => e.message,
    );
    await vi.advanceTimersByTimeAsync(5_100);
    expect(await settled).toMatch(/timed out/);
  });

  it('ignores a late close from a socket it already replaced', async () => {
    const c = await freshClient();
    c.connect();
    const old = FakeSocket.instances[0];
    old.handshake();
    c.setCredentials('ws://test2', 'tok2'); // swaps the socket
    const fresh = FakeSocket.instances[FakeSocket.instances.length - 1];
    fresh.handshake();
    await settle();
    expect(c.connected).toBe(true);
    old.onclose?.(); // stale event must not flip the new link to disconnected
    expect(c.connected).toBe(true);
  });

  it('retries after a failed handshake instead of sitting on a dead socket', async () => {
    const c = await freshClient();
    c.connect();
    const ws = FakeSocket.instances[0];
    ws.open();
    ws.push({ type: 'event', event: 'connect.challenge', payload: {} });
    const req = ws.sent.find((r) => r.method === 'connect');
    ws.push({ type: 'res', id: req.id, ok: false, error: { message: 'bad token' } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(FakeSocket.instances.length).toBeGreaterThan(1);
    expect(c.connected).toBe(false);
  });

  it('a message sent during a blip waits for the link and then goes out once', async () => {
    const c = await freshClient();
    c.connect();
    FakeSocket.instances[0].handshake();
    FakeSocket.instances[0].onclose?.(); // link drops
    const sending = c.sendMessage('hello');
    await vi.advanceTimersByTimeAsync(2_000);
    const fresh = FakeSocket.instances[FakeSocket.instances.length - 1];
    fresh.handshake();
    await settle();
    await vi.advanceTimersByTimeAsync(50);
    const sends = fresh.sent.filter((r) => r.method === 'chat.send');
    expect(sends).toHaveLength(1);
    fresh.push({ type: 'res', id: sends[0].id, ok: true, payload: {} });
    await expect(sending).resolves.toBeUndefined();
  });
});
