import type { ChatMessage } from '../types';

/**
 * Rebuild the chat from the gateway's history without losing what only this window knows yet:
 * Sir's message that was just sent, a reply still streaming in, the catch-up brief and service notes.
 * Anything the history already contains (same text, or a final reply that starts with our partial
 * one) is dropped, so a reconnect never shows duplicates and never wipes live messages.
 */
export function mergeHistory(hist: ChatMessage[], prev: ChatMessage[]): ChatMessage[] {
  if (hist.length === 0) return prev;
  const recent = hist.slice(-30);
  const seen = new Set(recent.map((m) => `${m.role}|${m.text.trim()}`));
  const keep = prev.filter((m) => {
    if (/^(brief_|svc_)/.test(m.id)) return true;
    if (!/^(usr_|streaming-|asst_)/.test(m.id)) return false;
    const text = m.text.trim();
    if (!text) return false;
    if (seen.has(`${m.role}|${text}`)) return false;
    if (m.role === 'assistant') {
      const head = text.slice(0, 60);
      if (recent.some((h) => h.role === 'assistant' && h.text.trim().startsWith(head))) return false;
    }
    return true;
  });
  return [...hist, ...keep];
}

/** A reply bubble that was still streaming when its run was lost becomes an ordinary message. */
export function sealStreaming(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m, i) => (m.id.startsWith('streaming-') ? { ...m, id: `asst_sealed_${m.timestamp}_${i}` } : m));
}
