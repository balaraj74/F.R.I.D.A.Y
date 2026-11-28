// The order of events when the bar is summoned (shake or shortcut):
//   read pointer -> capture the screen (overlay not visible yet) -> show overlay -> start session.
// The overlay window is built in parallel with the capture but stays hidden until the picture exists.
//
// states: idle -> capturing -> open -> idle
export function createSummonFlow({getPointer, prepareOverlay, capture, showOverlay, discardOverlay = () => {}, session, log = () => {}, notify = () => {}}) {
  let state = 'idle';
  return {
    get state() {
      return state;
    },
    get isOpen() {
      return state !== 'idle';
    },
    async summon(source) {
      if (state !== 'idle') {
        log(`summon (${source}) ignored: ${state}`);
        return false;
      }
      state = 'capturing';
      try {
        const pointer = getPointer();
        const ready = prepareOverlay(pointer);
        const shot = await capture().catch(() => ({image: null, partial: true}));
        const prepared = await ready;
        showOverlay(prepared, pointer);
        state = 'open';
        if (!shot?.image || shot?.partial) notify('Part of the screen could not be read.');
        session.summon({shot: shot?.image ?? null});
        return true;
      } catch (err) {
        log(`summon failed: ${err?.message ?? err}`);
        state = 'idle';
        try {
          discardOverlay();
        } catch {
          // already gone
        }
        return false;
      }
    },
    /** The overlay closed (Esc, close button or destroyed). */
    closed() {
      if (state === 'idle') return;
      state = 'idle';
      session.dismiss();
    },
  };
}
