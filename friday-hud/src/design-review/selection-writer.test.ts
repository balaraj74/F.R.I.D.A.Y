import { describe, expect, it, vi } from 'vitest';
import { createSelectionWriter, NOTE_TOO_LONG_MESSAGE } from './selection-writer';
import type { SelectionEntry, SelectionFile } from './types';

const entry = (over: Partial<SelectionEntry> = {}): SelectionEntry => ({
  screen: 'home',
  direction: 'glass',
  index: 0,
  verdict: 'keep',
  note: '',
  ...over,
});

describe('createSelectionWriter', () => {
  it('persists the verdict and note for a valid update', async () => {
    const persist = vi.fn(async (_file: SelectionFile) => {});
    const writer = createSelectionWriter(undefined, persist);
    const result = await writer.submit(entry({ verdict: 'mix', note: 'soft edges' }));
    expect(result).toEqual({ ok: true });
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0][0]).toEqual({
      version: 1,
      entries: [entry({ verdict: 'mix', note: 'soft edges' })],
    });
  });

  it('accepts a note of exactly 500 characters', async () => {
    const persist = vi.fn(async () => {});
    const writer = createSelectionWriter(undefined, persist);
    expect(await writer.submit(entry({ note: 'a'.repeat(500) }))).toEqual({ ok: true });
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('rejects a 501-character note without writing or changing the held selection', async () => {
    const persist = vi.fn(async () => {});
    const initial: SelectionFile = { version: 1, entries: [entry({ note: 'old' })] };
    const writer = createSelectionWriter(initial, persist);
    const result = await writer.submit(entry({ verdict: 'reject', note: 'a'.repeat(501) }));
    expect(result).toEqual({ ok: false, error: NOTE_TOO_LONG_MESSAGE });
    expect(NOTE_TOO_LONG_MESSAGE).toContain('500');
    expect(persist).not.toHaveBeenCalled();
    expect(writer.current()).toBe(initial);
  });

  it('replaces the entry for the same image and keeps other entries', async () => {
    const persist = vi.fn(async (_file: SelectionFile) => {});
    const other = entry({ screen: 'chat', direction: 'editorial', index: 1, verdict: 'reject' });
    const writer = createSelectionWriter({ version: 1, entries: [entry(), other] }, persist);
    await writer.submit(entry({ verdict: 'reject', note: 'no' }));
    expect(persist.mock.calls[0][0].entries).toEqual([entry({ verdict: 'reject', note: 'no' }), other]);
  });

  it('rolls back the held selection and reports an error when persistence fails', async () => {
    const writer = createSelectionWriter(undefined, async () => {
      throw new Error('disk full');
    });
    const result = await writer.submit(entry());
    expect(result).toEqual({ ok: false, error: 'Could not save selection: disk full' });
    expect(writer.current().entries).toEqual([]);
  });

  it('serialises writes so they never interleave', async () => {
    const order: string[] = [];
    const persist = vi.fn(async (file: SelectionFile) => {
      order.push(`start:${file.entries.length}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end:${file.entries.length}`);
    });
    const writer = createSelectionWriter(undefined, persist);
    await Promise.all([writer.submit(entry({ index: 0 })), writer.submit(entry({ index: 1 }))]);
    expect(order).toEqual(['start:1', 'end:1', 'start:2', 'end:2']);
  });
});
