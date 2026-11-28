import {afterEach, describe, expect, it, vi} from 'vitest';
import {transcribe} from '../../daemon/voice.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildInferenceForm, cleanTranscript, transcribeWav} from './stt.mjs';

const wav = (seconds) => new Uint8Array(44 + Math.round(seconds * 32000));
const okJson = (text) => ({ok: true, status: 200, json: async () => ({text})});

afterEach(() => vi.unstubAllGlobals());

describe('transcribeWav', () => {
  it('posts the file, json format and an audio_ctx to /inference', async () => {
    const fetchImpl = vi.fn(async () => okJson(' hello   world '));
    expect(await transcribeWav('http://127.0.0.1:18950', wav(2), fetchImpl)).toBe('hello world');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:18950/inference');
    expect(init.method).toBe('POST');
    expect(init.body.get('response_format')).toBe('json');
    expect(init.body.get('audio_ctx')).toBe(String(Math.ceil(2 * 50) + 128));
    expect(init.body.get('file').type).toBe('audio/wav');
  });
  it('caps audio_ctx at 1500', () => {
    expect(buildInferenceForm(wav(60)).get('audio_ctx')).toBe('1500');
  });
  it('drops noise markers and throws on HTTP errors', async () => {
    expect(await transcribeWav('http://x', wav(1), async () => okJson('[BLANK_AUDIO]'))).toBe('');
    await expect(transcribeWav('http://x', wav(1), async () => ({ok: false, status: 503}))).rejects.toThrow(/HTTP 503/);
  });
  it.each(['[BLANK_AUDIO]', '(silence)', ' [Music] ', '(inaudible)', 'hello', 'Blank_audio is a phrase I said'])(
    'matches the Linux transcribe() for %j',
    async (text) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fqb-'));
      const file = path.join(dir, 'a.wav');
      fs.writeFileSync(file, wav(1));
      vi.stubGlobal('fetch', vi.fn(async () => okJson(text)));
      const linux = await transcribe('http://x', file);
      fs.rmSync(dir, {recursive: true, force: true});
      expect(cleanTranscript(text)).toBe(linux);
    },
  );
});
