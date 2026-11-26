// Client for FRIDAY's fast brain (gateway `brain.ack`): a one-line acknowledgement that shows she
// understood the request, spoken while the main brain works. While Sir is still talking we ask
// speculatively on the partial transcript, so the line is usually ready the moment he stops.

import { gateway } from './gateway-ws';

const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);

function similarity(a: string, b: string): number {
  const A = new Set(words(a));
  const B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.max(A.size, B.size);
}

type Entry = { text: string; at: number; ack: Promise<string> };

class FastBrainClient {
  private recent: Entry[] = [];
  private prefetchTimer: ReturnType<typeof setTimeout> | null = null;

  private request(text: string): Promise<string> {
    const entry: Entry = {
      text,
      at: Date.now(),
      ack: gateway
        .request<{ ack?: string }>('brain.ack', { text })
        .then((r) => (typeof r?.ack === 'string' ? r.ack : ''))
        .catch(() => ''),
    };
    this.recent = [entry, ...this.recent.filter((e) => Date.now() - e.at < 60_000)].slice(0, 6);
    return entry.ack;
  }

  /** Partial transcript while Sir is speaking: ask early (debounced) so the ack is ready at the end. */
  prefetch(partial: string) {
    if (words(partial).length < 3) return;
    if (this.prefetchTimer) clearTimeout(this.prefetchTimer);
    this.prefetchTimer = setTimeout(() => {
      const best = this.recent[0];
      // Still the same request as the last speculative one: don't spend another call.
      if (best && similarity(best.text, partial) >= 0.8) return;
      void this.request(partial);
    }, 600);
  }

  /** The acknowledgement for a message being sent: reuse a speculative one if it's about the same thing. */
  ackFor(text: string): Promise<string> {
    if (this.prefetchTimer) clearTimeout(this.prefetchTimer);
    const match = this.recent.find((e) => Date.now() - e.at < 30_000 && similarity(e.text, text) >= 0.6);
    return match ? match.ack : this.request(text);
  }
}

export const fastBrain = new FastBrainClient();
