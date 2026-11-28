import {describe, expect, it, vi} from 'vitest';
import {leadParagraphIfComplete, pickSpoken} from '../../daemon/speak-text.mjs';
import {QUICK_NOTE, SESSION_KEY} from './message.mjs';
import {QuickSession} from './session.mjs';

const tick = () => new Promise((r) => setTimeout(r, 0));

function rig({ensureOk = true, speak = true, stt = 'http://stt'} = {}) {
  const events = [];
  const chats = [];
  let handlers = null;
  const gateway = {
    connect: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    chat: vi.fn(async (req) => {
      chats.push(req);
      handlers = req;
      return `run${chats.length}`;
    }),
  };
  const spoken = [];
  const speaker = {
    stop: vi.fn(),
    say: vi.fn(async (t) => {
      spoken.push(t);
      return true;
    }),
  };
  const s = new QuickSession({
    gateway,
    ensureGateway: async (status) => {
      status('Starting FRIDAY...');
      return ensureOk ? {ok: true} : {ok: false, error: 'The gateway did not start within 90 seconds.'};
    },
    ensureStt: async () => stt,
    transcribe: vi.fn(async () => 'hello there'),
    speaker,
    emit: (e) => events.push(e),
    speech: {pickSpoken, leadParagraphIfComplete},
    speakEnabled: () => speak,
  });
  return {s, events, chats, gateway, speaker, spoken, handlers: () => handlers};
}

describe('QuickSession', () => {
  it('sends the first question with the screenshot, later ones without', async () => {
    const r = rig();
    const image = {base64: 'QQ==', mimeType: 'image/jpeg'};
    r.s.summon({shot: Promise.resolve(image)});
    await r.s.ask('what is on screen?');
    expect(r.chats[0].sessionKey).toBe(SESSION_KEY);
    expect(r.chats[0].image).toBe(image);
    expect(r.chats[0].message).toContain('A screenshot of his screen is attached.');
    await r.s.ask('and now?');
    expect(r.chats[1].image).toBeNull();
    expect(r.chats[1].message).toBe(`and now?\n\n${QUICK_NOTE}`);
  });
  it('shows status lines, streams deltas and the final answer', async () => {
    const r = rig();
    r.s.summon({shot: null});
    await r.s.ask('hi');
    r.handlers().onDelta('Hel');
    r.handlers().onFinal('Hello.');
    const kinds = r.events.map((e) => e.ev);
    expect(kinds).toContain('status');
    expect(r.events).toContainEqual({ev: 'status', text: 'Thinking...'});
    expect(r.events).toContainEqual({ev: 'delta', text: 'Hel'});
    expect(r.events).toContainEqual({ev: 'final', text: 'Hello.'});
  });
  it('speaks the first paragraph once, as soon as it is complete', async () => {
    const r = rig();
    r.s.summon({shot: null});
    await r.s.ask('hi');
    r.handlers().onDelta('It is a spreadsheet of sales.');
    expect(r.spoken).toHaveLength(0);
    r.handlers().onDelta('It is a spreadsheet of sales.\n\nColumns are A to F.');
    await tick();
    r.handlers().onFinal('It is a spreadsheet of sales.\n\nColumns are A to F.');
    await tick();
    expect(r.spoken).toEqual(['It is a spreadsheet of sales.']);
    expect(r.events).toContainEqual({ev: 'speaking', on: true});
    expect(r.events).toContainEqual({ev: 'speaking', on: false});
  });
  it('speaks the lead at the end when the answer has no paragraph break', async () => {
    const r = rig();
    r.s.summon({shot: null});
    await r.s.ask('hi');
    r.handlers().onFinal('Just one line.');
    await tick();
    expect(r.spoken).toEqual(['Just one line.']);
  });
  it('does not speak when voice is none', async () => {
    const r = rig({speak: false});
    r.s.summon({shot: null});
    await r.s.ask('hi');
    r.handlers().onFinal('Just one line.');
    await tick();
    expect(r.spoken).toHaveLength(0);
  });
  it('reports a gateway that never came up', async () => {
    const r = rig({ensureOk: false});
    r.s.summon({shot: null});
    await tick();
    await r.s.ask('hi');
    expect(r.events).toContainEqual({ev: 'error', message: 'The gateway did not start within 90 seconds.'});
    expect(r.gateway.chat).not.toHaveBeenCalled();
  });
  it('aborts the previous run when a new question arrives and when dismissed', async () => {
    const r = rig();
    r.s.summon({shot: null});
    await r.s.ask('one');
    await r.s.ask('two');
    expect(r.gateway.abort).toHaveBeenCalledWith(SESSION_KEY, 'run1');
    await r.s.dismiss();
    expect(r.gateway.abort).toHaveBeenCalledWith(SESSION_KEY, 'run2');
    expect(r.speaker.stop).toHaveBeenCalled();
  });
  it('ignores empty questions', async () => {
    const r = rig();
    await r.s.ask('   ');
    expect(r.gateway.chat).not.toHaveBeenCalled();
  });
  it('turns recorded audio into a transcript', async () => {
    const r = rig();
    await r.s.audio(new Uint8Array(32044));
    expect(r.events).toContainEqual({ev: 'mic', state: 'idle'});
    expect(r.events).toContainEqual({ev: 'transcript', text: 'hello there'});
  });
  it('answers an empty transcript for tiny recordings', async () => {
    const r = rig();
    await r.s.audio(new Uint8Array(100));
    expect(r.events).toContainEqual({ev: 'transcript', text: ''});
  });
  it('says voice input is off when speech recognition is not running', async () => {
    const r = rig({stt: null});
    await r.s.audio(new Uint8Array(32044));
    const err = r.events.find((e) => e.ev === 'error');
    expect(err.message).toMatch(/Voice input is off/);
  });
  it('reports a send failure from the gateway', async () => {
    const r = rig();
    r.gateway.chat.mockRejectedValueOnce(new Error('not connected to the gateway'));
    r.s.summon({shot: null});
    await r.s.ask('hi');
    expect(r.events).toContainEqual({ev: 'error', message: 'not connected to the gateway'});
  });
});
