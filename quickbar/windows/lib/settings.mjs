// Parsing of the small JSON files the host reads. All functions are pure: they take text or an
// object and return plain values, and never throw on bad input.

export const TTS_MODES = Object.freeze(['edge', 'supertonic-gpu', 'none']);
export const DEFAULT_SHORTCUTS = Object.freeze(['Control+Alt+Space', 'Control+Alt+Shift+Space', 'Control+Alt+Q']);

function toObject(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** ~/.friday/setup.json -> what the quick bar needs. A missing or broken file means Edge voice, quick bar on. */
export function parseSetup(raw) {
  const o = toObject(raw);
  const tts = TTS_MODES.includes(o?.voice?.tts) ? o.voice.tts : 'edge';
  return {
    tts,
    stt: typeof o?.voice?.stt === 'string' ? o.voice.stt : 'whisper-cpu',
    quickbarEnabled: o?.quickbar?.enabled !== false,
  };
}

/** ~/.friday/quickbar.json: optional `speak: false` and `shortcut`. */
export function parseOwnConfig(raw) {
  const o = toObject(raw);
  return {
    speak: o.speak !== false,
    shortcut: typeof o.shortcut === 'string' && o.shortcut.trim() ? o.shortcut.trim() : null,
  };
}

/** Which speech engine to use: setup.json decides, `speak:false` or FRIDAY_QUICKBAR_SPEAK=0 turns it off. */
export function resolveSpeechMode({setup, own, env = {}}) {
  if (env.FRIDAY_QUICKBAR_SPEAK === '0') return 'none';
  if (env.FRIDAY_QUICKBAR_SPEAK === undefined && own?.speak === false) return 'none';
  return setup.tts;
}

/** ~/.friday/run/control.json written by the desktop tool: {active, since, action}. */
export function parseControl(raw) {
  const o = toObject(raw);
  return {
    active: o.active === true,
    since: typeof o.since === 'string' || typeof o.since === 'number' ? o.since : null,
    action: typeof o.action === 'string' ? o.action : '',
  };
}

/** Shortcut candidates in order: the user's own choice first, then the defaults. */
export function shortcutCandidates(own, defaults = DEFAULT_SHORTCUTS) {
  const list = own?.shortcut ? [own.shortcut, ...defaults] : [...defaults];
  return [...new Set(list)];
}

/**
 * Registers the first shortcut that is free. `register(accel, fn)` returns true on success.
 * Returns {accelerator, preferred}: accelerator is null when none could be registered, and
 * `preferred` is false when the first choice was taken by another program.
 */
export function registerFirstFree(register, candidates, handler) {
  for (let i = 0; i < candidates.length; i++) {
    let ok = false;
    try {
      ok = register(candidates[i], handler) === true;
    } catch {
      ok = false;
    }
    if (ok) return {accelerator: candidates[i], preferred: i === 0};
  }
  return {accelerator: null, preferred: false};
}
