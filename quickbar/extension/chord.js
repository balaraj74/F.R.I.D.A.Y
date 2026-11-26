// Recognises "F + Space" held together, and nothing else.
//
// Pure logic (no GNOME imports). A real chord keeps both keys down at the same time for a
// moment. Fast typing ("if " or "of ") only overlaps the two keys for a few milliseconds, so the
// chord must be held for `holdMs` before it counts. Any other key pressed in between cancels it.

export const CHORD_DEFAULTS = Object.freeze({holdMs: 110});

export class ChordDetector {
    /**
     * @param {(delayMs: number, fn: () => void) => (() => void)} schedule
     *   Runs fn after delayMs and returns a cancel function. Injected so tests control time.
     * @param {() => void} onChord called once per chord
     */
    constructor(schedule, onChord, options = {}) {
        this._o = {...CHORD_DEFAULTS, ...options};
        this._schedule = schedule;
        this._onChord = onChord;
        this._fDown = false;
        this._spaceDown = false;
        this._cancel = null;
        this._fired = false;
    }

    /** @param {'f'|'space'|'other'} key @param {boolean} pressed */
    onKey(key, pressed) {
        if (key === 'other') {
            if (pressed) this._abort();
            return;
        }
        if (key === 'f') this._fDown = pressed;
        else this._spaceDown = pressed;

        if (!pressed) {
            this._abort();
            if (!this._fDown && !this._spaceDown) this._fired = false;
            return;
        }
        if (this._fDown && this._spaceDown && !this._fired && !this._cancel) {
            this._cancel = this._schedule(this._o.holdMs, () => {
                this._cancel = null;
                if (this._fDown && this._spaceDown && !this._fired) {
                    this._fired = true;
                    this._onChord();
                }
            });
        }
    }

    _abort() {
        if (this._cancel) {
            this._cancel();
            this._cancel = null;
        }
    }
}
