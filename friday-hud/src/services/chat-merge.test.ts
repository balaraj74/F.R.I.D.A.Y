import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../types';
import { mergeHistory, sealStreaming } from './chat-merge';

const m = (id: string, role: ChatMessage['role'], text: string, timestamp = 1): ChatMessage => ({ id, role, text, timestamp });

describe('mergeHistory', () => {
  it('keeps the live chat when history comes back empty', () => {
    const prev = [m('usr_1', 'user', 'hi')];
    expect(mergeHistory([], prev)).toBe(prev);
  });

  it('keeps a message just sent and a reply still streaming', () => {
    const hist = [m('h1', 'user', 'earlier'), m('h2', 'assistant', 'old reply')];
    const prev = [m('usr_9', 'user', 'new question'), m('streaming-9', 'assistant', 'Working on')];
    const out = mergeHistory(hist, prev);
    expect(out.map((x) => x.id)).toEqual(['h1', 'h2', 'usr_9', 'streaming-9']);
  });

  it('drops local copies the history already has (no duplicates)', () => {
    const hist = [m('h1', 'user', 'question'), m('h2', 'assistant', 'The final answer is 42, Sir.')];
    const prev = [m('usr_1', 'user', 'question'), m('streaming-1', 'assistant', 'The final answer is 42')];
    expect(mergeHistory(hist, prev)).toEqual(hist);
  });

  it('keeps the catch-up brief and service notes, and drops stale history ids', () => {
    const hist = [m('h1', 'user', 'a')];
    const prev = [m('h0', 'user', 'old'), m('brief_1', 'assistant', 'brief'), m('svc_1', 'system', 'note')];
    expect(mergeHistory(hist, prev).map((x) => x.id)).toEqual(['h1', 'brief_1', 'svc_1']);
  });
});

describe('sealStreaming', () => {
  it('turns an orphaned streaming bubble into a normal message so a new reply starts a new bubble', () => {
    const out = sealStreaming([m('usr_1', 'user', 'x'), m('streaming-5', 'assistant', 'partial', 5)]);
    expect(out[1].id.startsWith('streaming-')).toBe(false);
    expect(out[1].text).toBe('partial');
  });
});
