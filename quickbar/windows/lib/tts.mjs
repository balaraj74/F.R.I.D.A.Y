// Turns text into audio for the chosen voice (setup.json voice.tts): `edge` (Microsoft neural voice
// through the edge-tts command) or `supertonic-gpu` (local server). The overlay plays the result.
import path from 'node:path';

export const EDGE_DEFAULT_VOICE = 'en-IE-EmilyNeural'; // same default as the HUD

/** Where edge-tts lives: the voice venv written by the installer, else whatever is on PATH. */
export function edgeTtsBinary({platform, home, exists}) {
  const venv = path.join(home, '.friday', 'voice-venv');
  const candidate = platform === 'win32' ? path.win32.join(venv, 'Scripts', 'edge-tts.exe') : path.join(venv, 'bin', 'edge-tts');
  return exists(candidate) ? candidate : 'edge-tts';
}

/** An argument vector, never a shell string: the text is model output. */
export function edgeTtsArgs({voice = EDGE_DEFAULT_VOICE, text, file}) {
  return ['--voice', String(voice), '--text', text, '--write-media', file];
}

export function supertonicRequest({base, token, text, voice, speed}) {
  return {
    url: `${base}/tts`,
    init: {
      method: 'POST',
      headers: {'content-type': 'application/json', ...(token ? {'x-friday-voice-token': token} : {})},
      body: JSON.stringify({text, voice, speed}),
    },
  };
}

/**
 * @param {object} o
 * @param {'edge'|'supertonic-gpu'|'none'} o.mode
 * @param {string} o.text already cleaned for speech
 * @param {object} o.deps {execFile, fetch, readRuntime, readVoiceSettings, binary, tmpFile, readFile, rm}
 * @returns {Promise<{mimeType:string, bytes:Uint8Array}|null>}
 */
export async function synthesize({mode, text, deps}) {
  if (mode === 'none' || !text) return null;
  if (mode === 'supertonic-gpu') {
    const runtime = deps.readRuntime();
    if (!runtime?.token) return null;
    const settings = deps.readVoiceSettings();
    const base = `http://127.0.0.1:${runtime.ports?.supertonic ?? 18952}`;
    const {url, init} = supertonicRequest({
      base,
      token: runtime.token,
      text,
      voice: settings.supertonicVoice,
      speed: settings.supertonicSpeed,
    });
    const res = await deps.fetch(url, {...init, signal: AbortSignal.timeout(30_000)}).catch(() => null);
    if (!res?.ok) return null;
    return {mimeType: 'audio/wav', bytes: new Uint8Array(await res.arrayBuffer())};
  }
  // Edge voice cannot do expression tags.
  const plain = text.replace(/\s*<(sigh|breath|laugh)>\s*/gi, ' ').trim();
  if (!plain) return null;
  const file = deps.tmpFile('mp3');
  const ok = await new Promise((resolve) => {
    deps.execFile(deps.binary, edgeTtsArgs({text: plain, file, voice: deps.edgeVoice}), {timeout: 15_000, windowsHide: true}, (err) =>
      resolve(!err),
    );
  });
  try {
    if (!ok) return null;
    const bytes = deps.readFile(file);
    return bytes?.length > 100 ? {mimeType: 'audio/mpeg', bytes} : null;
  } catch {
    return null;
  } finally {
    deps.rm(file);
  }
}
