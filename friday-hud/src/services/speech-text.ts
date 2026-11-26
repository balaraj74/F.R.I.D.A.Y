// Pure text rules for streaming speech: what part of a (still-growing) reply can be spoken,
// where to cut it into sentences, and how to clean each sentence for TTS.

export type Synth = { kind: 'blob' | 'file'; url: string } | { kind: 'browser' };

export function releaseSynth(s: Synth) {
  if (s.kind === 'blob') URL.revokeObjectURL(s.url);
}

const FENCE = '```';
// FRIDAY's sign-off line ("— FRIDAY 🦾"): shown in chat, never read aloud.
const SIGN_OFF = /^\s*[—–-]+\s*FRIDAY\b.*$/im;

/**
 * The part of a cumulative reply that is safe to speak. Closed code blocks become a line
 * break; an unclosed one (still streaming) cuts the text off at its opening fence. The result
 * only ever grows as the reply grows, so already-spoken prefixes stay stable.
 */
export function speakableText(full: string, done: boolean): string {
  let out = '';
  let i = 0;
  while (i < full.length) {
    const open = full.indexOf(FENCE, i);
    if (open < 0) { out += full.slice(i); break; }
    out += full.slice(i, open);
    const close = full.indexOf(FENCE, open + FENCE.length);
    if (close < 0) return out; // code block still streaming (or unterminated): stop here
    out += '\n';
    i = close + FENCE.length;
  }
  return done ? out.replace(SIGN_OFF, '') : out;
}

const MIN_CHUNK = 100; // merge short sentences into phrases so her intonation flows instead of resetting

/**
 * Cut complete sentences off the front of `text`. A sentence ends at . ! ? followed by
 * whitespace (but not a bare list number like "1.") or at a line break. Returns the chunks
 * and how many characters they consumed; the incomplete tail is left for later unless `done`.
 */
export function takeSpeakableChunks(
  text: string,
  done: boolean,
  /** true once part of this reply has already been queued */
  started = false,
): { chunks: string[]; consumed: number } {
  const chunks: string[] = [];
  let start = 0;
  let pending = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const atBreak = c === '\n';
    const atStop = (c === '.' || c === '!' || c === '?') && /\s/.test(text[i + 1] ?? '') && !isListNumber(text, i);
    if (!atBreak && !atStop) continue;
    pending += text.slice(start, i + 1);
    start = i + 1;
    // The first chunk goes out immediately (time to first audio matters); later ones are merged.
    const first = !started && chunks.length === 0;
    if (first ? pending.trim().length > 0 : pending.trim().length >= MIN_CHUNK) {
      chunks.push(pending);
      pending = '';
    }
  }
  if (done) {
    pending += text.slice(start);
    if (pending.trim()) chunks.push(pending);
    return { chunks, consumed: text.length };
  }
  return { chunks, consumed: start - pending.length };
}

function isListNumber(text: string, dotIndex: number): boolean {
  if (text[dotIndex] !== '.') return false;
  const lineStart = text.lastIndexOf('\n', dotIndex - 1) + 1;
  return /^\s*\d+$/.test(text.slice(lineStart, dotIndex));
}

// A person reads out the opening, not the report: lists, headings and tables stay on screen.
const STRUCTURE = /^[ \t]*(?:[-*•+]\s|#{1,6}\s|\||\d+[.)]\s)/m;
/** Longest opening spoken word for word; the rest is said as a short spoken summary. */
export const SPOKEN_LEAD_MAX = 450;

/** Index where the conversational opening of `text` ends (first list/heading/table line), or -1. */
export function proseEnd(text: string): number {
  const m = STRUCTURE.exec(text);
  return m ? m.index : -1;
}

/** Voice directions never show on screen. */
export function stripExpressionTags(text: string): string {
  return text.replace(/[ \t]*<(sigh|breath|laugh)>[ \t]*/gi, ' ').replace(/^ +/gm, '');
}

/** Markdown and symbols out, plain speakable words in. Empty string means "skip". */
export function cleanForSpeech(chunk: string): string {
  return chunk
    .replace(new RegExp(SIGN_OFF.source, 'gim'), '') // drop only the sign-off line, keep the rest
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!?\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/^\s*(?:[-*•]|\d+\.)\s+/gm, '')
    .replace(/[*_~#|]/g, '')
    .replace(/(?<!<(?:sigh|breath|laugh))>/gi, '') // keep the voice's <sigh>/<breath>/<laugh> tags
    // Typographic punctuation carries the rhythm of speech: turn it into what the voice
    // understands instead of deleting it (a dropped em dash ran two thoughts together, and a
    // curly apostrophe split "I’m" into "I m").
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s*[\u2014\u2013]\s*/g, ', ')
    .replace(/\u2026/g, '...')
    .replace(/[^\x00-\x7F]/g, ' ')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/,\s*([,.!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
