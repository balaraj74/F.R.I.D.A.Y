// One way to run an animation: full display rate only when it matters, a gentle rate otherwise.
// Low rates use a timer instead of requestAnimationFrame so the page isn't woken (and the
// transparent window recomposited) 60+ times a second for a slow glow. Stops while hidden.

export function startFrameLoop(step: (now: number) => void, fps: () => number): () => void {
  let stopped = false;
  let raf = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const next = () => {
    if (stopped) return;
    if (document.hidden) {
      timer = setTimeout(next, 500);
      return;
    }
    const rate = fps();
    const draw = () => {
      raf = requestAnimationFrame((now) => {
        if (stopped) return;
        step(now);
        next();
      });
    };
    if (rate >= 50) draw();
    else timer = setTimeout(draw, 1000 / Math.max(1, rate));
  };
  next();
  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    if (timer) clearTimeout(timer);
  };
}
