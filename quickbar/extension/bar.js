// The floating command bar: an input row, a mic button and a streaming answer area, placed next
// to the pointer. Plain St widgets in the shell process, so it appears with no startup cost.
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const BAR_WIDTH = 480;
const HEADER_ROW_HEIGHT = 96;
const MIN_ANSWER_HEIGHT = 120;
const MAX_ANSWER_HEIGHT = 340;
const CURSOR_GAP = 14;
const EDGE_GAP = 8;

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
        this._actor = null;
        this._grab = null;
        this._pinned = false;
        this._recording = false;
        this._outsideId = 0;
    }

    get isOpen() {
        return !!this._actor;
    }

    _monitorFor(x, y) {
        const monitors = Main.layoutManager.monitors;
        const idx = monitors.findIndex(m => x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height);
        return idx >= 0 ? idx : Main.layoutManager.primaryIndex;
    }

    _build() {
        const bar = new St.BoxLayout({style_class: 'fqb-bar', vertical: true, reactive: true, width: BAR_WIDTH});

        const header = new St.BoxLayout({style_class: 'fqb-header'});
        this._title = new St.Label({text: 'FRIDAY', style_class: 'fqb-title', y_align: Clutter.ActorAlign.CENTER});
        this._status = new St.Label({text: '', style_class: 'fqb-status', y_expand: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._status.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._speakerBtn = this._iconButton('audio-volume-high-symbolic', () => this._h.onSilence(), 'Stop speaking');
        this._speakerBtn.hide();
        this._pinBtn = this._iconButton('view-pin-symbolic', () => this._togglePin(), 'Keep open');
        const closeBtn = this._iconButton('window-close-symbolic', () => this.close(), 'Close');
        header.add_child(this._title);
        header.add_child(this._status);
        header.add_child(this._speakerBtn);
        header.add_child(this._pinBtn);
        header.add_child(closeBtn);

        const row = new St.BoxLayout({style_class: 'fqb-row'});
        this._entry = new St.Entry({
            style_class: 'fqb-entry',
            hint_text: "Ask FRIDAY about what's on your screen",
            can_focus: true,
            x_expand: true,
        });
        this._entry.clutter_text.connect('activate', () => this._submit());
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

        bar.add_child(header);
        bar.add_child(row);
        bar.add_child(this._scroll);
        bar.connect('key-press-event', (_a, ev) => this._onKey(ev));
        return bar;
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

    /** Shows the bar next to the pointer. */
    open(px, py) {
        if (this._actor) return;
        this._pinned = false;
        this._actor = this._build();
        Main.layoutManager.addTopChrome(this._actor);

        const idx = this._monitorFor(px, py);
        const area = Main.layoutManager.getWorkAreaForMonitor(idx);
        // The bar's top-left corner sits just below and right of the pointer. It only moves when
        // the screen edge leaves no room, and then by the smallest amount needed.
        const bottom = area.y + area.height - EDGE_GAP;
        const minBody = HEADER_ROW_HEIGHT + MIN_ANSWER_HEIGHT;
        let x = px + CURSOR_GAP;
        let y = py + CURSOR_GAP;
        if (x + BAR_WIDTH > area.x + area.width - EDGE_GAP) x = px - CURSOR_GAP - BAR_WIDTH;
        x = Math.max(area.x + EDGE_GAP, Math.min(x, area.x + area.width - BAR_WIDTH - EDGE_GAP));
        if (y + minBody > bottom) y = Math.max(area.y + EDGE_GAP, bottom - minBody);
        // The answer area gets the room that is left below the bar's input row.
        const answerMax = Math.max(MIN_ANSWER_HEIGHT, Math.min(MAX_ANSWER_HEIGHT, bottom - y - HEADER_ROW_HEIGHT));
        this._scroll.style = `max-height: ${answerMax}px;`;
        console.log(`quickbar: bar at ${x},${y} for pointer ${px},${py} on monitor ${idx} (work area ${area.x},${area.y} ${area.width}x${area.height})`);
        this._actor.set_position(x, y);
        this._actor.opacity = 0;
        this._actor.show();
        this._actor.ease({opacity: 255, duration: 90, mode: Clutter.AnimationMode.EASE_OUT_QUAD});

        this._grab = Main.pushModal(this._actor, {actionMode: Shell.ActionMode.POPUP});
        global.stage.set_key_focus(this._entry.clutter_text);

        // Clicking anywhere outside the bar dismisses it (unless it is pinned).
        this._outsideId = global.stage.connect('captured-event', (_s, ev) => {
            if (ev.type() === Clutter.EventType.BUTTON_PRESS && !this._pinned) {
                const src = ev.get_source();
                if (src && !this._actor?.contains(src)) this.close();
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    close() {
        if (!this._actor) return;
        if (this._outsideId) global.stage.disconnect(this._outsideId);
        this._outsideId = 0;
        this._releaseGrab();
        const actor = this._actor;
        this._actor = null;
        this._recording = false;
        actor.remove_all_transitions();
        actor.destroy();
        this._h.onClose();
    }

    _releaseGrab() {
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
    }

    _togglePin() {
        this._pinned = !this._pinned;
        if (this._pinned) {
            this._pinBtn.add_style_pseudo_class('checked');
            this._releaseGrab();
        } else {
            this._pinBtn.remove_style_pseudo_class('checked');
            this._grab = Main.pushModal(this._actor, {actionMode: Shell.ActionMode.POPUP});
            global.stage.set_key_focus(this._entry.clutter_text);
        }
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
        if (!this._actor) return;
        this._scroll.show();
        this._answer.set_text(displayText(text));
    }

    setSpeaking(on) {
        if (!this._speakerBtn) return;
        if (on) this._speakerBtn.show();
        else this._speakerBtn.hide();
    }

    setMic(state) {
        this._recording = state === 'recording';
        this._applyMicState();
    }

    /** A voice transcript arrived: ask it straight away. */
    onTranscript(text) {
        if (!this._actor) return;
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
        if (this._actor && !this._pinned) global.stage.set_key_focus(this._entry.clutter_text);
    }

    onError(message) {
        this.setStatus('');
        this.setAnswer(`Something went wrong: ${message}`);
    }

    destroy() {
        if (this._actor) this.close();
    }
}
