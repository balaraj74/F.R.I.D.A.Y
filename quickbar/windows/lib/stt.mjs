// Speech to text over HTTP: whisper.cpp `/inference` (port 18950). Same request and noise filter as
// transcribe() in quickbar/daemon/voice.mjs, but takes the WAV bytes so no recording touches disk.

export const NOISE = /^\s*[[(]?\s*(blank_audio|silence|music|inaudible|no speech|sound|noise)[^\])]*[\])]?\s*$/i;

export function cleanTranscript(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return NOISE.test(t) ? '' : t;
}

export function buildInferenceForm(wavBytes, FormDataImpl = FormData, BlobImpl = Blob) {
  const seconds = Math.max(0.2, (wavBytes.length - 44) / 32000);
  const form = new FormDataImpl();
  form.append('file', new BlobImpl([wavBytes], {type: 'audio/wav'}), 'speech.wav');
  form.append('response_format', 'json');
  form.append('audio_ctx', String(Math.min(1500, Math.ceil(seconds * 50) + 128)));
  return form;
}

/** Whisper transcript of a 16 kHz mono WAV, or '' when nothing intelligible was heard. */
export async function transcribeWav(sttBase, wavBytes, fetchImpl = fetch) {
  const res = await fetchImpl(`${sttBase}/inference`, {
    method: 'POST',
    body: buildInferenceForm(wavBytes),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`speech recognition failed (HTTP ${res.status})`);
  return cleanTranscript((await res.json()).text);
}
