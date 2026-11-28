import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {fridayPaths} from './paths.mjs';
import {parseControl, parseOwnConfig, parseSetup, registerFirstFree, resolveSpeechMode, shortcutCandidates} from './settings.mjs';

describe('parseSetup', () => {
  it('reads the voice choice and quick bar flag', () => {
    const s = parseSetup(JSON.stringify({version: 1, voice: {tts: 'supertonic-gpu', stt: 'whisper-gpu'}, quickbar: {enabled: false}}));
    expect(s).toEqual({tts: 'supertonic-gpu', stt: 'whisper-gpu', quickbarEnabled: false});
  });
  it.each(['edge', 'supertonic-gpu', 'none'])('accepts %s', (tts) => {
    expect(parseSetup({voice: {tts}}).tts).toBe(tts);
  });
  it.each([null, '', 'not json', '[]', '{"voice":{"tts":"kokoro"}}', 42])('falls back to edge for %j', (raw) => {
    const s = parseSetup(raw);
    expect(s.tts).toBe('edge');
    expect(s.quickbarEnabled).toBe(true);
  });
});

describe('speech mode', () => {
  const setup = parseSetup({voice: {tts: 'edge'}});
  it('follows setup.json', () => {
    expect(resolveSpeechMode({setup, own: parseOwnConfig(null)})).toBe('edge');
  });
  it('is turned off by speak:false or FRIDAY_QUICKBAR_SPEAK=0', () => {
    expect(resolveSpeechMode({setup, own: parseOwnConfig('{"speak":false}')})).toBe('none');
    expect(resolveSpeechMode({setup, own: parseOwnConfig(null), env: {FRIDAY_QUICKBAR_SPEAK: '0'}})).toBe('none');
  });
  it('lets FRIDAY_QUICKBAR_SPEAK=1 override speak:false, like the daemon', () => {
    expect(resolveSpeechMode({setup, own: parseOwnConfig('{"speak":false}'), env: {FRIDAY_QUICKBAR_SPEAK: '1'}})).toBe('edge');
  });
});

describe('parseControl', () => {
  it('reads active', () => {
    expect(parseControl('{"active":true,"since":"2026-01-01T00:00:00Z","action":"click"}')).toEqual({
      active: true,
      since: '2026-01-01T00:00:00Z',
      action: 'click',
    });
  });
  it('treats anything but true as inactive', () => {
    for (const raw of [null, '', '{', '{"active":"yes"}', '{"active":1}', '{"active":false}']) expect(parseControl(raw).active).toBe(false);
  });
});

describe('shortcuts', () => {
  it('puts the user choice first and removes duplicates', () => {
    expect(shortcutCandidates({shortcut: 'Control+Alt+Space'})[0]).toBe('Control+Alt+Space');
    expect(shortcutCandidates({shortcut: 'Control+Alt+Space'}).filter((s) => s === 'Control+Alt+Space')).toHaveLength(1);
    expect(shortcutCandidates({shortcut: 'Alt+Y'})[0]).toBe('Alt+Y');
  });
  it('registers the first free one and reports when the preferred was taken', () => {
    const taken = new Set(['Control+Alt+Space']);
    const r = registerFirstFree((a) => !taken.has(a), ['Control+Alt+Space', 'Control+Alt+Q'], () => {});
    expect(r).toEqual({accelerator: 'Control+Alt+Q', preferred: false});
    expect(registerFirstFree(() => true, ['A', 'B'], () => {})).toEqual({accelerator: 'A', preferred: true});
    expect(registerFirstFree(() => false, ['A'], () => {})).toEqual({accelerator: null, preferred: false});
    expect(registerFirstFree(() => { throw new Error('x'); }, ['A'], () => {}).accelerator).toBeNull();
  });
});

describe('fridayPaths', () => {
  it('builds the contract paths under .friday', () => {
    const p = fridayPaths('/h');
    expect(p.setup).toBe(path.join('/h', '.friday', 'setup.json'));
    expect(p.control).toBe(path.join('/h', '.friday', 'run', 'control.json'));
    expect(p.stop).toBe(path.join('/h', '.friday', 'run', 'stop'));
    expect(p.voiceRuntime).toBe(path.join('/h', '.friday', 'voice', 'runtime.json'));
  });
});
