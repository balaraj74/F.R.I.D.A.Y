// Turns microphone samples into the 16 kHz mono 16-bit WAV that Whisper /inference expects.
// Plain typed arrays and DataView only, so the same file runs in the overlay renderer and in tests.

export const WAV_RATE = 16000;

/** Averages (downsampling) or interpolates (upsampling) Float32 samples to a new rate. */
export function resample(input, fromRate, toRate = WAV_RATE) {
  if (fromRate === toRate || input.length === 0) return Float32Array.from(input);
  const ratio = fromRate / toRate;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);
  if (ratio > 1) {
    for (let i = 0; i < outLen; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let j = start; j < end; j++) sum += input[j];
      out[i] = sum / (end - start);
    }
  } else {
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const j = Math.floor(pos);
      const f = pos - j;
      const a = input[j];
      const b = input[Math.min(j + 1, input.length - 1)];
      out[i] = a + (b - a) * f;
    }
  }
  return out;
}

export function floatToPcm16(samples) {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

/** 44-byte RIFF header followed by little-endian PCM data. */
export function wavFromPcm16(pcm, rate = WAV_RATE) {
  const dataBytes = pcm.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const text = (offset, s) => {
    for (let i = 0; i < s.length; i++) v.setUint8(offset + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  text(36, 'data');
  v.setUint32(40, dataBytes, true);
  for (let i = 0; i < pcm.length; i++) v.setInt16(44 + i * 2, pcm[i], true);
  return new Uint8Array(buf);
}

/** @param {Float32Array[]} chunks mono chunks as captured at `inputRate` */
export function encodeWav16kMono(chunks, inputRate) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const all = new Float32Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return wavFromPcm16(floatToPcm16(resample(all, inputRate, WAV_RATE)), WAV_RATE);
}
