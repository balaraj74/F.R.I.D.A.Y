import { useCallback, useEffect, useRef } from 'react';

/**
 * Keep a chat scrolled to the newest message, but only while Sir is at the bottom. If he scrolls up
 * to read, new tokens must not yank him back down. Sending a message always jumps to the bottom.
 */
export function useStickToBottom(lastRole: string | undefined, deps: unknown[]) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }, []);

  useEffect(() => {
    if (lastRole === 'user') stick.current = true;
    const el = containerRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { containerRef, onScroll };
}
