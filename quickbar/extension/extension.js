// FRIDAY Quick Bar: shake the mouse (or hold F + Space) to ask about what is on screen.
//
// This file only does what must happen inside the shell: watch the pointer and keys, grab the
// screen, and show the bar next to the cursor. Everything heavy (gateway, voice) is in the
// separate daemon the bar talks to (quickbar/daemon).
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {QuickBar} from './bar.js';
import {ChordDetector} from './chord.js';
import {DaemonLink} from './ipc.js';
import {ShakeDetector} from './shake.js';

const SCREENSHOT_TIMEOUT_MS = 1500;
const MOD_MASK = Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.MOD1_MASK | Clutter.ModifierType.SUPER_MASK;

export default class FridayQuickBar extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._summoning = false;
        this._lastDebug = 0;
        this._moves = 0;
        this._timers = new Set();
        this._shakeOn = this._settings.get_boolean('shake-enabled');
        this._chordOn = this._settings.get_boolean('chord-enabled');
        this._makeShake();
        this._settingsIds = [
            this._settings.connect('changed::shake-enabled', () => {
                this._shakeOn = this._settings.get_boolean('shake-enabled');
                this._shake.reset();
            }),
            ...['shake-min-stroke', 'shake-reversals', 'shake-min-speed', 'shake-debug'].map(key =>
                this._settings.connect(`changed::${key}`, () => this._makeShake())),
            this._settings.connect('changed::chord-enabled', () => {
                this._chordOn = this._settings.get_boolean('chord-enabled');
            }),
        ];

        this._link = new DaemonLink(ev => this._onDaemonEvent(ev), msg => console.log(msg));
        this._bar = new QuickBar({
            onAsk: text => this._ask(text),
            onMic: action => this._link.send({op: 'mic', action}),
            onSilence: () => this._link.send({op: 'silence'}),
            onClose: () => this._link.send({op: 'dismiss'}),
        });

        this._chord = new ChordDetector(
            (ms, fn) => this._schedule(ms, fn),
            () => this._summon('chord'),
        );

        this._stageId = global.stage.connect('captured-event', (_s, ev) => this._onStageEvent(ev));

        Main.wm.addKeybinding(
            'summon-shortcut',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this._summon('shortcut'),
        );
    }

    disable() {
        Main.wm.removeKeybinding('summon-shortcut');
        if (this._stageId) global.stage.disconnect(this._stageId);
        this._stageId = 0;
        for (const id of this._settingsIds ?? []) this._settings.disconnect(id);
        this._settingsIds = null;
        for (const id of this._timers ?? []) GLib.source_remove(id);
        this._timers?.clear();
        this._bar?.destroy();
        this._bar = null;
        this._link?.destroy();
        this._link = null;
        this._chord = null;
        this._shake = null;
        this._settings = null;
    }

    /** Builds the shake detector from the current settings (also called when a setting changes). */
    _makeShake() {
        const get = key => this._settings.get_int(key);
        this._shakeDebug = this._settings.get_boolean('shake-debug');
        this._shake = new ShakeDetector({
            minStroke: get('shake-min-stroke'),
            minReversals: get('shake-reversals'),
            minSpeed: get('shake-min-speed'),
        });
        console.log(`quickbar: shake detector ready (stroke ${get('shake-min-stroke')} px, ` +
            `${get('shake-reversals')} reversals, ${get('shake-min-speed')} px/s, debug ${this._shakeDebug})`);
    }

    _schedule(ms, fn) {
        let id = 0;
        id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timers.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timers.add(id);
        return () => {
            if (this._timers.delete(id)) GLib.source_remove(id);
        };
    }

    // ---- triggers ----

    _onStageEvent(ev) {
        // Never interfere with events: this only observes.
        if (!this._bar || this._bar.isOpen) return Clutter.EVENT_PROPAGATE;
        switch (ev.type()) {
        case Clutter.EventType.MOTION:
            if (this._shakeOn) {
                // A button held down means a drag or a selection, not a shake.
                if (ev.get_state() & Clutter.ModifierType.BUTTON1_MASK) {
                    this._shake.reset();
                } else {
                    const [x, y] = ev.get_coords();
                    const now = GLib.get_monotonic_time() / 1000;
                    this._moves++;
                    if (this._shake.push(x, y, now)) {
                        if (this._shakeDebug) console.log('quickbar: shake detected');
                        this._summon('shake');
                    } else if (this._shakeDebug && now - this._lastDebug > 400) {
                        // Only while the pointer is clearly doing something shake-like, to keep the log short.
                        const m = this._shake.metrics();
                        if (m.reversals >= 1 && m.speed > 300) {
                            this._lastDebug = now;
                            console.log(`quickbar: motion events=${this._moves} samples=${m.n} reversals=${m.reversals} ` +
                                `range=${Math.round(m.mainRange)}px cross=${Math.round(m.crossRange)}px speed=${Math.round(m.speed)}px/s`);
                        }
                    }
                }
            }
            break;
        case Clutter.EventType.KEY_PRESS:
        case Clutter.EventType.KEY_RELEASE:
            if (this._chordOn) this._onKey(ev);
            break;
        default:
            break;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onKey(ev) {
        const pressed = ev.type() === Clutter.EventType.KEY_PRESS;
        const sym = ev.get_key_symbol();
        let key = 'other';
        if (!(ev.get_state() & MOD_MASK)) {
            if (sym === Clutter.KEY_f || sym === Clutter.KEY_F) key = 'f';
            else if (sym === Clutter.KEY_space) key = 'space';
        }
        this._chord.onKey(key, pressed);
    }

    // ---- summon ----

    _captureScreen() {
        return new Promise(resolve => {
            let settled = false;
            const finish = value => {
                if (settled) return;
                settled = true;
                resolve(value);
            };
            this._schedule(SCREENSHOT_TIMEOUT_MS, () => finish(null));
            try {
                const dir = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'friday-quickbar']);
                GLib.mkdir_with_parents(dir, 0o700);
                const path = GLib.build_filenamev([dir, `shot-${Date.now()}.png`]);
                const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.PRIVATE, null);
                const shooter = new Shell.Screenshot();
                shooter.screenshot(false, stream, (obj, res) => {
                    try {
                        obj.screenshot_finish(res);
                        stream.close(null);
                        finish(path);
                    } catch (e) {
                        console.log(`quickbar: screenshot failed: ${e.message}`);
                        try {
                            stream.close(null);
                        } catch {
                            // ignore
                        }
                        finish(null);
                    }
                });
            } catch (e) {
                console.log(`quickbar: screenshot failed: ${e.message}`);
                finish(null);
            }
        });
    }

    async _summon(_source) {
        if (!this._bar || this._bar.isOpen || this._summoning) return;
        this._summoning = true;
        try {
            const [px, py] = global.get_pointer();
            const linked = this._link.connect(); // starts the daemon while the screenshot is taken
            // The picture comes first, so the bar never appears in it.
            const shot = await this._captureScreen();
            if (!this._bar) return;
            this._bar.open(px, py);
            if (await linked) this._link.send({op: 'summon', shot});
            else this._bar.setStatus('FRIDAY is not running. Run the installer once.');
        } catch (e) {
            console.log(`quickbar: summon failed: ${e.message}`);
        } finally {
            this._summoning = false;
        }
    }

    async _ask(text) {
        this._bar.setStatus('Sending...');
        if (!(await this._link.connect()) || !this._link.send({op: 'ask', text})) {
            this._bar.onError('could not reach the quick bar service');
        }
    }

    // ---- daemon events ----

    _onDaemonEvent(ev) {
        if (!this._bar?.isOpen) return;
        switch (ev.ev) {
        case 'status':
            this._bar.setStatus(ev.text);
            break;
        case 'delta':
            this._bar.setStatus('');
            this._bar.setAnswer(ev.text);
            break;
        case 'final':
            this._bar.onFinal(ev.text);
            break;
        case 'error':
            this._bar.onError(ev.message);
            break;
        case 'mic':
            this._bar.setMic(ev.state);
            break;
        case 'transcript':
            this._bar.onTranscript(ev.text);
            break;
        case 'speaking':
            this._bar.setSpeaking(ev.on);
            break;
        case 'disconnected':
            this._bar.setStatus('Lost the connection to FRIDAY');
            break;
        default:
            break;
        }
    }
}
