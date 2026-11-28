import {describe, expect, it, vi} from 'vitest';
import {createEnsureGateway} from './gateway-up.mjs';

function clock() {
  let t = 0;
  return {now: () => t, sleep: async (ms) => { t += ms; }};
}

describe('ensureGateway', () => {
  it('returns at once when the port answers', async () => {
    const startServices = vi.fn();
    const ensure = createEnsureGateway({tcpUp: async () => true, port: 18789, startServices, ...clock()});
    expect(await ensure()).toEqual({ok: true});
    expect(startServices).not.toHaveBeenCalled();
  });
  it('shows "Starting FRIDAY...", asks for a start once and waits for the port', async () => {
    let up = false;
    let probes = 0;
    const startServices = vi.fn();
    const status = vi.fn();
    const ensure = createEnsureGateway({
      tcpUp: async () => {
        if (++probes > 4) up = true;
        return up;
      },
      port: 18789,
      startServices,
      ...clock(),
    });
    expect(await ensure(status)).toEqual({ok: true});
    expect(status).toHaveBeenCalledWith('Starting FRIDAY...');
    expect(startServices).toHaveBeenCalledTimes(1);
  });
  it('gives an error after the timeout, then asks again next time', async () => {
    const startServices = vi.fn();
    const ensure = createEnsureGateway({tcpUp: async () => false, port: 1, startServices, timeoutMs: 5000, ...clock()});
    const r = await ensure();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/did not start within 5 seconds/);
    await ensure();
    expect(startServices).toHaveBeenCalledTimes(2);
  });
  it('concurrent callers share one wait', async () => {
    const startServices = vi.fn();
    let probes = 0;
    const ensure = createEnsureGateway({tcpUp: async () => ++probes > 3, port: 1, startServices, ...clock()});
    const [a, b] = await Promise.all([ensure(), ensure()]);
    expect(a).toEqual(b);
    expect(startServices).toHaveBeenCalledTimes(1);
  });
  it('survives a failing start request', async () => {
    let probes = 0;
    const ensure = createEnsureGateway({tcpUp: async () => ++probes > 2, port: 1, startServices: async () => { throw new Error('x'); }, ...clock()});
    expect((await ensure()).ok).toBe(true);
  });
});
