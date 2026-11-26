import { useMemo, useState } from 'react';
import './design-review.css';
import { groupForGallery } from './group';
import { createSelectionWriter, NOTE_TOO_LONG_MESSAGE, type SelectionWriter, type SubmitResult } from './selection-writer';
import {
  NOTE_MAX_LENGTH,
  SCREENS,
  STYLE_DIRECTIONS,
  VERDICTS,
  type Manifest,
  type ManifestEntry,
  type PersistSelection,
  type SelectionFile,
  type Verdict,
} from './types';

export type DesignReviewGalleryProps = {
  /** Parsed `manifest.json` from `friday design refs`. */
  manifest: Manifest;
  /** Parsed existing `selection.json`, if any, so earlier verdicts are shown and kept. */
  initialSelection?: SelectionFile;
  /** Writes the full selection to `selection.json`. Injected so the gallery has no I/O of its own. */
  persistSelection: PersistSelection;
  /** Maps a manifest entry to an `<img src>`. Defaults to the entry's `path`. */
  resolveImageSrc?: (entry: ManifestEntry) => string;
};

type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; message: string };

function label(entry: ManifestEntry): string {
  return `${entry.screen} / ${entry.direction} #${entry.index + 1}`;
}

/** Error placeholder naming the Screen and Style_Direction of a failed entry (Req 1.8). */
function ErrorPlaceholder({ entry, reason }: { entry: ManifestEntry; reason: string }) {
  return (
    <div className="dr-placeholder" role="alert">
      <strong>Reference image unavailable</strong>
      <div>Screen: {entry.screen}</div>
      <div>Style direction: {entry.direction}</div>
      <div className="dr-placeholder-reason">{reason}</div>
    </div>
  );
}

function ReferenceCard({
  entry,
  writer,
  initialVerdict,
  initialNote,
  resolveImageSrc,
}: {
  entry: ManifestEntry;
  writer: SelectionWriter;
  initialVerdict: Verdict | null;
  initialNote: string;
  resolveImageSrc: (entry: ManifestEntry) => string;
}) {
  const [verdict, setVerdict] = useState<Verdict | null>(initialVerdict);
  const [note, setNote] = useState(initialNote);
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  const tooLong = note.length > NOTE_MAX_LENGTH;
  const src = entry.status === 'created' ? resolveImageSrc(entry) : '';

  const submit = async (nextVerdict: Verdict, nextNote: string) => {
    setSave({ kind: 'saving' });
    const result: SubmitResult = await writer.submit({
      screen: entry.screen,
      direction: entry.direction,
      index: entry.index,
      verdict: nextVerdict,
      note: nextNote,
    });
    setSave(result.ok ? { kind: 'saved' } : { kind: 'error', message: result.error });
  };

  const chooseVerdict = (next: Verdict) => {
    setVerdict(next);
    void submit(next, note);
  };

  // A note edit is written once the field loses focus, and only when a verdict exists.
  const commitNote = () => {
    if (verdict) void submit(verdict, note);
  };

  return (
    <li className="dr-card" data-testid={`ref-${entry.screen}-${entry.direction}-${entry.index}`}>
      {entry.status === 'failed' ? (
        <ErrorPlaceholder entry={entry} reason={entry.failureReason ?? 'Generation failed.'} />
      ) : src ? (
        <img className="dr-image" src={src} alt={`Reference image ${label(entry)}`} />
      ) : (
        <ErrorPlaceholder entry={entry} reason="No image file is recorded for this entry." />
      )}

      {entry.status === 'created' && (
        <>
          <div className="dr-verdicts" role="radiogroup" aria-label={`Verdict for ${label(entry)}`}>
            {VERDICTS.map((v) => (
              <label key={v} className="dr-verdict">
                <input
                  type="radio"
                  name={`verdict-${entry.screen}-${entry.direction}-${entry.index}`}
                  value={v}
                  checked={verdict === v}
                  onChange={() => chooseVerdict(v)}
                />
                {v}
              </label>
            ))}
          </div>
          <textarea
            className="dr-note"
            aria-label={`Note for ${label(entry)}`}
            aria-invalid={tooLong}
            value={note}
            rows={3}
            onChange={(e) => setNote(e.target.value)}
            onBlur={commitNote}
          />
          <div className="dr-status">
            <span>
              {note.length}/{NOTE_MAX_LENGTH}
            </span>
            {tooLong ? (
              <span className="dr-error" role="alert">
                {NOTE_TOO_LONG_MESSAGE}
              </span>
            ) : save.kind === 'error' ? (
              <span className="dr-error" role="alert">
                {save.message}
              </span>
            ) : save.kind === 'saving' ? (
              <span>Saving…</span>
            ) : save.kind === 'saved' ? (
              <span>Saved</span>
            ) : null}
          </div>
        </>
      )}
    </li>
  );
}

export function DesignReviewGallery({
  manifest,
  initialSelection,
  persistSelection,
  resolveImageSrc = (entry) => entry.path ?? '',
}: DesignReviewGalleryProps) {
  const groups = useMemo(() => groupForGallery(manifest), [manifest]);
  // One writer for the component's lifetime keeps writes ordered and the held selection current.
  const [writer] = useState(() => createSelectionWriter(initialSelection, persistSelection));

  const existing = (entry: ManifestEntry) =>
    initialSelection?.entries.find(
      (s) => s.screen === entry.screen && s.direction === entry.direction && s.index === entry.index,
    );

  return (
    <div className="dr-gallery">
      <h1 className="dr-title">Design review</h1>
      {SCREENS.map((screen) => (
        <section key={screen} className="dr-screen" aria-labelledby={`dr-screen-${screen}`}>
          <h2 id={`dr-screen-${screen}`}>{screen}</h2>
          {STYLE_DIRECTIONS.map((direction) => {
            const entries = groups[screen][direction];
            return (
              <div key={direction} className="dr-direction" data-testid={`group-${screen}-${direction}`}>
                <h3>{direction}</h3>
                {entries.length === 0 ? (
                  <p className="dr-empty">No reference images yet.</p>
                ) : (
                  <ul className="dr-list">
                    {entries.map((entry) => {
                      const prior = existing(entry);
                      return (
                        <ReferenceCard
                          key={`${entry.index}`}
                          entry={entry}
                          writer={writer}
                          initialVerdict={prior?.verdict ?? null}
                          initialNote={prior?.note ?? ''}
                          resolveImageSrc={resolveImageSrc}
                        />
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
