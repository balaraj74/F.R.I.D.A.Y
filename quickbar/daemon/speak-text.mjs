// Decides which part of an answer is read aloud, and cleans it for the voice.
// The full answer always stays readable on screen; only the lead is spoken.

const MAX_SPOKEN_CHARS = 320;
const MAX_SPOKEN_SENTENCES = 3;

/** Removes reply tags and silent markers the gateway can leave in a reply. */
export function stripReplyTags(text) {
  return String(text ?? '')
    .replace(/\[\[\s*reply_to[^\]]*\]\]/gi, '')
    .replace(/^\s*NO_REPLY\s*$/gim, '')
    .replace(/^MEDIA:.*$/gim, '')
    .trim();
}

/** Plain speakable text: no code, tables, links or markup; curly punctuation kept readable. */
export function cleanForSpeech(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, ', ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/[*_~|>]/g, '')
    .replace(/[^\x20-\x7E\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitSentences(text) {
  // Split after . ! ? only when whitespace follows, so "app.ts" and "3.5" stay whole.
  return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

function clip(text) {
  const sentences = splitSentences(text);
  let out = '';
  let n = 0;
  for (const s of sentences) {
    if (n >= MAX_SPOKEN_SENTENCES) break;
    if (out && out.length + s.length + 1 > MAX_SPOKEN_CHARS) break;
    out = out ? `${out} ${s}` : s;
    n++;
  }
  if (!out) out = text;
  if (out.length > MAX_SPOKEN_CHARS) out = `${out.slice(0, MAX_SPOKEN_CHARS).replace(/\s+\S*$/, '')}.`;
  return out;
}

/** The first paragraph that is prose (not a heading, list or code), cleaned and clipped. */
export function pickSpoken(answer) {
  const text = stripReplyTags(answer).replace(/```[\s\S]*?```/g, '\n\n');
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  for (const p of paragraphs) {
    if (/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|\||>)/.test(p)) continue;
    const spoken = cleanForSpeech(p);
    if (spoken.length >= 3) return clip(spoken);
  }
  const all = cleanForSpeech(text);
  return all ? clip(all) : '';
}

/**
 * While an answer streams: the first full paragraph, once it is complete, so speech can start
 * before the rest is written. Returns '' until a paragraph break has arrived.
 */
export function leadParagraphIfComplete(partial) {
  const text = stripReplyTags(partial);
  const idx = text.search(/\n{2,}/);
  if (idx < 20) return '';
  return pickSpoken(text.slice(0, idx));
}
