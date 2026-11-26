// The floating command bar: a frosted-glass card next to the pointer, with an animated light running
// around its edge. It is an overlay, not a dialog: windows behind it stay clickable and the bar stays
// open until you close it. Click the bar to type in it; click a window and typing goes there again.
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {colorAt, glowFrame, intensityAt, roundedRectPoints} from './glow.js';

const CARD_WIDTH = 500;
const CARD_RADIUS = 24;
const PAD = 24; // room around the card for the light
const CURSOR_GAP = 14;
const EDGE_GAP = 8;
const HEADER_ROW_HEIGHT = 104;
const MIN_ANSWER_HEIGHT = 120;
const MAX_ANSWER_HEIGHT = 340;
const GLOW_SEGMENTS = 96;
const GLOW_FRAME_MS = 33;
// Cairo constants (the shell does not export them): operator SOURCE replaces instead of blending,
// so overlapping round caps never double up into visible beads.
const CAIRO_OPERATOR_SOURCE = 1;
const CAIRO_LINE_CAP_ROUND = 1;
const GLOW_LAYERS = [
    {width: 22, alpha: 0.2},
    {width: 12, alpha: 0.36},
    {width: 5, alpha: 0.8},
    {width: 2, alpha: 1},
];
// The light runs on a path a little outside the card's edge, so it hugs the glass instead of hiding under it.
const GLOW_OUTSET = 3;

/** Light cleanup so markdown reads cleanly in a plain label. */
export function displayText(text) {
    return text
        .replace(/\[\[[^\]]*\]\]/g, '')
        .replace(/```[a-z]*\n?/gi, '')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/`([^`]+)`/g, '$1')
        .trim();
}

export class QuickBar {
    /**
     * @param {object} handlers
     * @param {(text: string) => void} handlers.onAsk
     * @param {(action: 'start'|'stop') => void} handlers.onMic
     * @param {() => void} handlers.onSilence
     * @param {() => void} handlers.onClose
     */
    constructor(handlers) {
        this._h = handlers;
        this._root = null;
        this._card = null;
        this._recording = false;
        this._mode = 'idle';
        this._glowTimer = 0;
        this._focusId = 0;
        this._outline = null;
        this._t0 = GLib.get_monotonic_time();
    }

    get isOpen() {
        return !!this._root;
    }

    _monitorFor(x, y) {
        const monitors = Main.layoutManager.monitors;
        const idx = monitors.findIndex(m => x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height);
        return idx >= 0 ? idx : Main.layoutManager.primaryIndex;
    }

    _build() {
        const root = new St.Widget({
            style_class: 'fqb-root',
            layout_manager: new Clutter.BinLayout(),
            reactive: false,
            width: CARD_WIDTH + 2 * PAD,
        });

        // Layer 1: the light. Drawn with Cairo, repainted about 30 times a second while the bar is open.
        this._glow = new St.DrawingArea({style_class: 'fqb-glow', x_expand: true, y_expand: true, reactive: false});
        this._glow.connect('repaint', area => this._paintGlow(area));

        // Layer 2: the glass card.
        const card = new St.BoxLayout({
            style_class: 'fqb-card',
            vertical: true,
            reactive: true,
            can_focus: false,
            x_expand: true,
            y_expand: true,
            style: `margin: ${PAD}px;`,
        });
        try {
            // Blurs whatever is behind the card, which is what makes it look like glass.
            card.add_effect_with_name('fqb-blur', new Shell.BlurEffect({
                radius: 28,
                brightness: 1.0,
                mode: Shell.BlurMode.BACKGROUND,
            }));
        } catch (e) {
            console.log(`quickbar: blur unavailable: ${e.message}`);
        }

        const header = new St.BoxLayout({style_class: 'fqb-header'});
        this._title = new St.Label({text: 'FRIDAY', style_class: 'fqb-title', y_align: Clutter.ActorAlign.CENTER});
        this._title.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._status = new St.Label({text: '', style_class: 'fqb-status', y_expand: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._status.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._speakerBtn = this._iconButton('audio-volume-high-symbolic', () => this._h.onSilence(), 'Stop speaking');
        this._speakerBtn.hide();
        const closeBtn = this._iconButton('window-close-symbolic', () => this.close(), 'Close');
        header.add_child(this._title);
        header.add_child(this._status);
        header.add_child(this._speakerBtn);
        header.add_child(closeBtn);

        const row = new St.BoxLayout({style_class: 'fqb-row'});
        this._entry = new St.Entry({
            style_class: 'fqb-entry',
            hint_text: "Ask FRIDAY about what's on your screen",
            can_focus: true,
            x_expand: true,
        });
        this._entry.clutter_text.connect('activate', () => this._submit());
        // Clicking the entry (or anywhere on the card) sends the keyboard here.
        this._entry.clutter_text.connect('key-focus-in', () => this._takeKeyboard());
        this._micBtn = this._iconButton('audio-input-microphone-symbolic', () => this._toggleMic(), 'Speak');
        this._micBtn.add_style_class_name('fqb-mic');
        row.add_child(this._entry);
        row.add_child(this._micBtn);

        this._question = new St.Label({style_class: 'fqb-question', text: ''});
        this._question.clutter_text.line_wrap = true;
        this._question.hide();

        this._answer = new St.Label({style_class: 'fqb-answer', text: ''});
        this._answer.clutter_text.line_wrap = true;
        this._answer.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._answer.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._answer.clutter_text.selectable = true;
        this._scroll = new St.ScrollView({
            style_class: 'fqb-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
        });
        const body = new St.BoxLayout({vertical: true, x_expand: true});
        body.add_child(this._question);
        body.add_child(this._answer);
        this._scroll.add_child(body);
        this._scroll.hide();

        card.add_child(header);
        card.add_child(row);
        card.add_child(this._scroll);
        card.connect('key-press-event', (_a, ev) => this._onKey(ev));
        card.connect('button-press-event', () => {
            this._takeKeyboard();
            return Clutter.EVENT_PROPAGATE;
        });

        root.add_child(card);
        root.add_child(this._glow); // above the card: it also covers the blur's square corners
        this._card = card;
        return root;
    }

    _iconButton(icon, onClick, accessibleName) {
        const btn = new St.Button({
            style_class: 'fqb-icon-btn',
            reactive: true,
            can_focus: true,
            accessible_name: accessibleName,
            child: new St.Icon({icon_name: icon, style_class: 'fqb-icon'}),
        });
        btn.connect('clicked', onClick);
        return btn;
    }

    // ---- keyboard: an overlay, not a modal grab ----

    /** Typing goes to the bar. Windows keep their place and stay clickable. */
    _takeKeyboard() {
        if (!this._root) return;
        global.stage.set_key_focus(this._entry.clutter_text);
        global.display.unset_input_focus(global.get_current_time());
    }

    /** A window was clicked: give typing back to it. The bar stays where it is. */
    _dropKeyboard() {
        const focus = global.stage.get_key_focus();
        if (this._card && focus && this._card.contains(focus)) global.stage.set_key_focus(null);
    }

    // ---- open / close ----

    /** Shows the bar next to the pointer. */
    open(px, py) {
        if (this._root) return;
        this._root = this._build();
        // Chrome sits above windows. Only the card (not the ring of light) takes mouse input.
        Main.layoutManager.addTopChrome(this._root);
        Main.layoutManager.untrackChrome(this._root);
        Main.layoutManager.trackChrome(this._card);

        const idx = this._monitorFor(px, py);
        const area = Main.layoutManager.getWorkAreaForMonitor(idx);
        // The card's top-left corner sits just below and right of the pointer. It only moves when the
        // screen edge leaves no room, and then by the smallest amount needed.
        const bottom = area.y + area.height - EDGE_GAP;
        const minBody = HEADER_ROW_HEIGHT + MIN_ANSWER_HEIGHT;
        let x = px + CURSOR_GAP;
        let y = py + CURSOR_GAP;
        if (x + CARD_WIDTH > area.x + area.width - EDGE_GAP) x = px - CURSOR_GAP - CARD_WIDTH;
        x = Math.max(area.x + EDGE_GAP, Math.min(x, area.x + area.width - CARD_WIDTH - EDGE_GAP));
        if (y + minBody > bottom) y = Math.max(area.y + EDGE_GAP, bottom - minBody);
        const answerMax = Math.max(MIN_ANSWER_HEIGHT, Math.min(MAX_ANSWER_HEIGHT, bottom - y - HEADER_ROW_HEIGHT));
        this._scroll.style = `max-height: ${answerMax}px;`;
        console.log(`quickbar: bar at ${x},${y} for pointer ${px},${py} on monitor ${idx}`);

        this._root.set_position(x - PAD, y - PAD);
        this._root.opacity = 0;
        this._root.show();
        this._root.ease({opacity: 255, duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD});

        // Typing goes to the bar at first; the moment a window is clicked it goes back to that window.
        // The shortcut that opened the bar is still being released for a moment, and the entry is not
        // on screen yet, so ask for the keyboard again a little later.
        this._takeKeyboard();
        for (const ms of [60, 220]) {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
                if (this._root && !this._userClickedAway) this._takeKeyboard();
                return GLib.SOURCE_REMOVE;
            });
        }
        this._userClickedAway = false;
        this._openedAt = GLib.get_monotonic_time();
        this._focusId = global.display.connect('notify::focus-window', () => {
            if (!global.display.focus_window) return;
            // A focus change in the first moments is the app regaining focus after the shortcut, not a click.
            if (GLib.get_monotonic_time() - this._openedAt > 400000) this._userClickedAway = true;
            this._dropKeyboard();
        });

        this._t0 = GLib.get_monotonic_time();
        this._glowTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, GLOW_FRAME_MS, () => {
            this._glow?.queue_repaint();
            return this._root ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
        });
    }

    close() {
        if (!this._root) return;
        if (this._focusId) global.display.disconnect(this._focusId);
        this._focusId = 0;
        if (this._glowTimer) GLib.source_remove(this._glowTimer);
        this._glowTimer = 0;
        this._dropKeyboard();
        const root = this._root;
        Main.layoutManager.untrackChrome(this._card);
        this._root = null;
        this._card = null;
        this._glow = null;
        this._recording = false;
        root.remove_all_transitions();
        root.ease({
            opacity: 0,
            duration: 110,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => root.destroy(),
        });
        this._h.onClose();
    }

    _onKey(ev) {
        const sym = ev.get_key_symbol();
        if (sym === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        const ctrl = (ev.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;
        if (ctrl && (sym === Clutter.KEY_m || sym === Clutter.KEY_M)) {
            this._toggleMic();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // ---- the light ----

    _paintGlow(area) {
        const [aw, ah] = area.get_surface_size();
        const w = aw - 2 * PAD;
        const h = ah - 2 * PAD;
        const cr = area.get_context();
        if (w > 40 && h > 40) {
            const key = `${w}x${h}`;
            if (this._outlineKey !== key) {
                this._outline = roundedRectPoints(w + 2 * GLOW_OUTSET, h + 2 * GLOW_OUTSET, CARD_RADIUS + GLOW_OUTSET, GLOW_SEGMENTS);
                this._outlineKey = key;
            }
            const pts = this._outline;
            const frame = glowFrame(this._mode, (GLib.get_monotonic_time() - this._t0) / 1e6);
            cr.translate(PAD - GLOW_OUTSET, PAD - GLOW_OUTSET);
            cr.setOperator(CAIRO_OPERATOR_SOURCE);
            cr.setLineCap(CAIRO_LINE_CAP_ROUND);
            for (const layer of GLOW_LAYERS) {
                cr.setLineWidth(layer.width);
                for (let i = 0; i < pts.length; i++) {
                    const u = i / pts.length;
                    const [r, g, b] = colorAt(u + frame.hueShift);
                    cr.setSourceRGBA(r, g, b, layer.alpha * intensityAt(frame, u));
                    const next = pts[(i + 1) % pts.length];
                    cr.moveTo(pts[i][0], pts[i][1]);
                    cr.lineTo(next[0], next[1]);
                    cr.stroke();
                }
            }
        }
        cr.$dispose();
    }

    /** idle | thinking | speaking: changes how the light moves. */
    setActivity(mode) {
        this._mode = mode;
    }

    // ---- input ----

    _submit() {
        const text = this._entry.get_text().trim();
        if (!text) return;
        this._entry.set_text('');
        this.showQuestion(text);
        this._h.onAsk(text);
    }

    showQuestion(text) {
        this._question.set_text(`You: ${text}`);
        this._question.show();
        this._answer.set_text('');
        this._scroll.show();
        this.setActivity('thinking');
    }

    _toggleMic() {
        this._recording = !this._recording;
        this._applyMicState();
        this._h.onMic(this._recording ? 'start' : 'stop');
    }

    _applyMicState() {
        if (!this._micBtn) return;
        if (this._recording) {
            this._micBtn.add_style_pseudo_class('checked');
            this.setStatus('Listening... press the mic or Ctrl+M when done');
        } else {
            this._micBtn.remove_style_pseudo_class('checked');
        }
    }

    // ---- events from the daemon ----

    setStatus(text) {
        this._status?.set_text(text ?? '');
    }

    setAnswer(text) {
        if (!this._root) return;
        this._scroll.show();
        this._answer.set_text(displayText(text));
    }

    setSpeaking(on) {
        if (!this._speakerBtn) return;
        if (on) {
            this._speakerBtn.show();
            this.setActivity('speaking');
        } else {
            this._speakerBtn.hide();
            if (this._mode === 'speaking') this.setActivity('idle');
        }
    }

    setMic(state) {
        this._recording = state === 'recording';
        this._applyMicState();
    }

    /** A voice transcript arrived: ask it straight away. */
    onTranscript(text) {
        if (!this._root) return;
        if (!text) {
            this.setStatus("I didn't catch that");
            return;
        }
        this.showQuestion(text);
        this._h.onAsk(text);
    }

    onFinal(text) {
        this.setStatus('');
        this.setAnswer(text);
        if (this._mode === 'thinking') this.setActivity('idle');
    }

    onError(message) {
        this.setStatus('');
        this.setAnswer(`Something went wrong: ${message}`);
        this.setActivity('idle');
    }

    destroy() {
        if (this._root) this.close();
    }
}
