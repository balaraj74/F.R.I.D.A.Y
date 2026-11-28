import {describe, expect, it, vi} from 'vitest';
import {createControlMonitor, createStopRequester} from './control.mjs';

describe('control monitor', () => {
  it('reports only changes of active', () => {
    let text = null;
    const onChange = vi.fn();
    const m = createControlMonitor({read: () => text, onChange});
    m.check();
    expect(onChange).not.toHaveBeenCalled();
    text = '{"active":true,"since":"t","action":"click"}';
    m.check();
    m.check();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].active).toBe(true);
    expect(m.active).toBe(true);
    text = '{"active":false}';
    m.check();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(m.active).toBe(false);
  });
  it('treats an unreadable file as inactive', () => {
    const onChange = vi.fn();
    const m = createControlMonitor({read: () => { throw new Error('EBUSY'); }, onChange});
    m.check();
    expect(onChange).not.toHaveBeenCalled();
    expect(m.active).toBe(false);
  });
  it('hides the indicator again when the file disappears', () => {
    let text = '{"active":true}';
    const seen = [];
    const m = createControlMonitor({read: () => text, onChange: (c) => seen.push(c.active)});
    m.check();
    text = null;
    m.check();
    expect(seen).toEqual([true, false]);
  });
});

describe('stop requester', () => {
  it('creates run/stop with its folder', () => {
    const fs = {mkdirSync: vi.fn(), writeFileSync: vi.fn()};
    const stop = createStopRequester({fs, stopFile: '/h/.friday/run/stop', now: () => new Date('2026-01-02T03:04:05Z')});
    expect(stop()).toBe(true);
    expect(fs.mkdirSync).toHaveBeenCalledWith('/h/.friday/run', {recursive: true});
    expect(fs.writeFileSync).toHaveBeenCalledWith('/h/.friday/run/stop', '2026-01-02T03:04:05.000Z\n');
  });
  it('really writes the file on disk', async () => {
    const fsReal = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fsReal.mkdtempSync(path.join(os.tmpdir(), 'fqb-stop-'));
    const file = path.join(dir, 'run', 'stop');
    expect(createStopRequester({fs: fsReal, stopFile: file})()).toBe(true);
    expect(fsReal.existsSync(file)).toBe(true);
    fsReal.rmSync(dir, {recursive: true, force: true});
  });
  it('returns false instead of throwing when the disk refuses', () => {
    const fs = {mkdirSync() { throw new Error('EACCES'); }, writeFileSync() {}};
    expect(createStopRequester({fs, stopFile: '/x/stop'})()).toBe(false);
  });
});
