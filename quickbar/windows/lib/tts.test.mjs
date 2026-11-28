import path from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {EDGE_DEFAULT_VOICE, edgeTtsArgs, edgeTtsBinary, supertonicRequest, synthesize} from './tts.mjs';

function deps(over = {}) {
  return {
    execFile: vi.fn((bin, args, opts, cb) => cb(null)),
    fetch: vi.fn(async () => ({ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer})),
    readRuntime: () => ({managed: true, token: 'tok', ports: {supertonic: 18952}}),
    readVoiceSettings: () => ({supertonicVoice: 'F1', supertonicSpeed: 0.9}),
    binary: 'edge-tts',
    tmpFile: (ext) => `/tmp/x.${ext}`,
    readFile: () => new Uint8Array(500),
    rm: vi.fn(),
    ...over,
  };
}

describe('edge voice', () => {
  it('finds the venv binary on Windows, else PATH', () => {
    const win = edgeTtsBinary({platform: 'win32', home: 'C:\\Users\\a', exists: () => true});
    expect(win).toBe('C:\\Users\\a\\.friday\\voice-venv\\Scripts\\edge-tts.exe');
    expect(edgeTtsBinary({platform: 'win32', home: 'C:\\Users\\a', exists: () => false})).toBe('edge-tts');
    expect(edgeTtsBinary({platform: 'linux', home: '/h', exists: () => true})).toBe(path.join('/h', '.friday', 'voice-venv', 'bin', 'edge-tts'));
  });
  it('passes the text as one argument, never through a shell', () => {
    const evil = 'hi $(calc) `x` "; rm';
    expect(edgeTtsArgs({text: evil, file: 'a.mp3'})).toEqual(['--voice', EDGE_DEFAULT_VOICE, '--text', evil, '--write-media', 'a.mp3']);
  });
  it('synthesizes mp3 and removes the temp file', async () => {
    const d = deps();
    const out = await synthesize({mode: 'edge', text: 'Hello <sigh> there', deps: d});
    expect(out.mimeType).toBe('audio/mpeg');
    expect(out.bytes.length).toBe(500);
    expect(d.execFile.mock.calls[0][1]).toContain('Hello there');
    expect(d.execFile.mock.calls[0][2].windowsHide).toBe(true);
    expect(d.rm).toHaveBeenCalledWith('/tmp/x.mp3');
  });
  it('gives null when edge-tts fails or writes too little', async () => {
    expect(await synthesize({mode: 'edge', text: 'hi', deps: deps({execFile: (b, a, o, cb) => cb(new Error('no'))})})).toBeNull();
    expect(await synthesize({mode: 'edge', text: 'hi', deps: deps({readFile: () => new Uint8Array(10)})})).toBeNull();
  });
});

describe('supertonic voice', () => {
  it('posts to the local server with the voice token', async () => {
    const d = deps();
    const out = await synthesize({mode: 'supertonic-gpu', text: 'Hello', deps: d});
    expect(out.mimeType).toBe('audio/wav');
    const [url, init] = d.fetch.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:18952/tts');
    expect(init.headers['x-friday-voice-token']).toBe('tok');
    expect(JSON.parse(init.body)).toEqual({text: 'Hello', voice: 'F1', speed: 0.9});
  });
  it('uses the port from runtime.json and gives null without a token or on HTTP failure', async () => {
    const d = deps({readRuntime: () => ({token: 't', ports: {supertonic: 19999}})});
    await synthesize({mode: 'supertonic-gpu', text: 'x', deps: d});
    expect(d.fetch.mock.calls[0][0]).toBe('http://127.0.0.1:19999/tts');
    expect(await synthesize({mode: 'supertonic-gpu', text: 'x', deps: deps({readRuntime: () => null})})).toBeNull();
    expect(await synthesize({mode: 'supertonic-gpu', text: 'x', deps: deps({fetch: async () => ({ok: false})})})).toBeNull();
  });
  it('builds the request', () => {
    expect(supertonicRequest({base: 'http://b', token: '', text: 't', voice: 'v', speed: 1}).init.headers).toEqual({'content-type': 'application/json'});
  });
});

describe('none', () => {
  it('produces no audio', async () => {
    const d = deps();
    expect(await synthesize({mode: 'none', text: 'hi', deps: d})).toBeNull();
    expect(d.execFile).not.toHaveBeenCalled();
    expect(d.fetch).not.toHaveBeenCalled();
  });
});
