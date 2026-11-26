import {
  NOTE_MAX_LENGTH,
  VERDICTS,
  type PersistSelection,
  type SelectionEntry,
  type SelectionFile,
} from './types';

export const NOTE_TOO_LONG_MESSAGE = `Note is too long. The limit is ${NOTE_MAX_LENGTH} characters.`;

export type SubmitResult = { ok: true } | { ok: false; error: string };

export type SelectionWriter = {
  /**
   * Validates the update, then calls the injected persistence function with the whole
   * selection. An invalid update (note over the limit, unknown verdict) resolves to an
   * error WITHOUT calling `persist` and without changing the held selection (Req 1.10).
   * There is no debounce: the write starts as soon as any earlier write finishes, which
   * keeps it inside the 1 second budget of Req 1.9. Writes are serialised so they never interleave.
   */
  submit: (update: SelectionEntry) => Promise<SubmitResult>;
  /** The selection as last accepted. */
  current: () => SelectionFile;
};

function sameEntry(a: SelectionEntry, b: SelectionEntry): boolean {
  return a.screen === b.screen && a.direction === b.direction && a.index === b.index;
}

/** Replaces (or appends) the entry for `update`'s Reference_Image. */
function withEntry(file: SelectionFile, update: SelectionEntry): SelectionFile {
  const next: SelectionEntry = {
    screen: update.screen,
    direction: update.direction,
    index: update.index,
    verdict: update.verdict,
    note: update.note,
  };
  const has = file.entries.some((e) => sameEntry(e, update));
  return {
    version: 1,
    entries: has ? file.entries.map((e) => (sameEntry(e, update) ? next : e)) : [...file.entries, next],
  };
}

export function createSelectionWriter(
  initial: SelectionFile | undefined,
  persist: PersistSelection,
): SelectionWriter {
  let held: SelectionFile = initial ?? { version: 1, entries: [] };
  let queue: Promise<unknown> = Promise.resolve();

  const submit = (update: SelectionEntry): Promise<SubmitResult> => {
    if (!(VERDICTS as readonly string[]).includes(update.verdict)) {
      return Promise.resolve({ ok: false, error: 'Choose exactly one of keep, reject or mix.' });
    }
    if (update.note.length > NOTE_MAX_LENGTH) {
      return Promise.resolve({ ok: false, error: NOTE_TOO_LONG_MESSAGE });
    }
    const previous = held;
    const next = withEntry(previous, update);
    held = next;
    const run = queue.then(async (): Promise<SubmitResult> => {
      try {
        await persist(next);
        return { ok: true };
      } catch (err) {
        // Roll back only if nothing newer was accepted in the meantime.
        if (held === next) held = previous;
        return { ok: false, error: `Could not save selection: ${err instanceof Error ? err.message : String(err)}` };
      }
    });
    queue = run;
    return run;
  };

  return { submit, current: () => held };
}
