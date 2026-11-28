// The overlay page: card, input, mic, and the travelling light drawn on a canvas.
// glow.js is the same module the Linux bar uses.
import {colorAt, glowFrame, intensityAt, mixColors, roundedRectPoints} from '../../extension/glow.js';
import {initialActivity, reduceActivity} from '../lib/activity.mjs';
import {MicRecorder} from './recorder.mjs';

const $ = (id) => document.getElementById(id);
const api = window.fqb;
const GLOW_SEGMENTS = 96;
const GLOW_FRAME_MS = 25; // about 40 frames a second while the bar is open
const GLOW_LAYERS = [
  {width: 9, alpha: 0.14},
  {width: 4.5, alpha: 0.34},
  {width: 1.7, alpha: 1},
];
const GLOW_OUTSET = 0.5;
const MODE_FADE_MS = 500;
const GLOW_MIN_VISIBLE = 0.03;
const RIM = {width: 1.4, lit: 0.85, shade: 0.14};
const INNER_RIM = {inset: 3, lit: 0.28, shade: 0.04};

let cfg = {pad: 0, radius: 26, answerMax: 340, material: false};
let activity = initialActivity();
let recorder = null;
let audioEl = null;
let glowTimer = 0;
const t0 = performance.now();

/** Light cleanup so markdown reads cleanly as plain text (same as displayText in bar.js). */
export function displayText(text) {
  return String(text)
    .replace(/\[\[[^\]]*\]\]/g, '')
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

function setActivity(ev) {
  activity = reduceActivity(activity, ev, performance.now());
  $('mic').classList.toggle('recording', activity.recording);
}

function setStatus(text) {
  $('status').textContent = text ?? '';
}

function showScroll() {
  $('scroll').hidden = false;
}

function setAnswer(text) {
  showScroll();
  $('answer').textContent = displayText(text);
}

function ask(text) {
  const q = text.trim();
  if (!q) return;
  $('entry').value = '';
  showQuestion(q);
  api.ask(q);
}

function showQuestion(text) {
  $('question').textContent = `You: ${text}`;
  $('question').hidden = false;
  $('answer').textContent = '';
  showScroll();
  setActivity({type: 'question'});
}

async function toggleMic() {
  if (!recorder) return;
  if (recorder.active) {
    setActivity({type: 'mic', state: 'idle'});
    const wav = await recorder.stop();
    if (wav) api.audio(wav);
    else setStatus("I didn't catch that");
    return;
  }
  api.mic('start');
  try {
    await recorder.start();
    setActivity({type: 'mic', state: 'recording'});
    setStatus('Listening... press the mic or Ctrl+M when done');
  } catch {
    setActivity({type: 'mic', state: 'idle'});
    setStatus('Voice input is off: the microphone is not available. You can still type.');
  }
}

function onEvent(ev) {
  switch (ev.ev) {
    case 'status':
      setStatus(ev.text);
      break;
    case 'delta':
      setStatus('');
      setAnswer(ev.text);
      break;
    case 'final':
      setStatus('');
      setAnswer(ev.text);
      setActivity({type: 'final'});
      break;
    case 'error':
      setStatus('');
      setAnswer(`Something went wrong: ${ev.message}`);
      setActivity({type: 'error'});
      break;
    case 'transcript':
      if (!ev.text) setStatus("I didn't catch that");
      else {
        showQuestion(ev.text);
        api.ask(ev.text);
      }
      break;
    case 'speaking':
      $('speaker').hidden = !ev.on;
      setActivity({type: 'speaking', on: ev.on});
      break;
    default:
      break;
  }
}

function play({mimeType, bytes}) {
  stopPlayback();
  const url = URL.createObjectURL(new Blob([bytes], {type: mimeType}));
  audioEl = new Audio(url);
  const done = (ok) => {
    URL.revokeObjectURL(url);
    if (audioEl) api.playbackDone(ok);
    audioEl = null;
  };
  audioEl.onended = () => done(true);
  audioEl.onerror = () => done(false);
  audioEl.play().catch(() => done(false));
}

function stopPlayback() {
  if (!audioEl) return;
  const a = audioEl;
  audioEl = null;
  a.onended = a.onerror = null;
  a.pause();
}

// ---- the light ----
let outline = null;
let inner = null;
let sizeKey = '';

function paintGlow() {
  const canvas = $('glow');
  const dpr = window.devicePixelRatio || 1;
  const cw = Math.round(canvas.clientWidth * dpr);
  const ch = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  const pad = cfg.pad;
  const w = canvas.clientWidth - 2 * pad;
  const h = canvas.clientHeight - 2 * pad;
  if (w <= 40 || h <= 40) return;
  const key = `${w}x${h}`;
  const outW = w + 2 * GLOW_OUTSET;
  const outH = h + 2 * GLOW_OUTSET;
  if (key !== sizeKey) {
    outline = roundedRectPoints(outW, outH, cfg.radius + GLOW_OUTSET, GLOW_SEGMENTS);
    inner = roundedRectPoints(outW - 2 * INNER_RIM.inset, outH - 2 * INNER_RIM.inset, cfg.radius - INNER_RIM.inset, GLOW_SEGMENTS);
    sizeKey = key;
  }
  const now = performance.now();
  const frame = glowFrame(activity.mode, (now - t0) / 1000);
  const fade = Math.min(1, Math.max(0, (now - activity.changedAt) / MODE_FADE_MS));
  ctx.translate(pad - GLOW_OUTSET, pad - GLOW_OUTSET);
  ctx.lineCap = 'butt';
  const seg = (a, b, offset = 0) => {
    ctx.beginPath();
    ctx.moveTo(a[0] + offset, a[1] + offset);
    ctx.lineTo(b[0] + offset, b[1] + offset);
    ctx.stroke();
  };
  // 1. The rim of the glass, brighter toward the top-left.
  ctx.lineWidth = RIM.width;
  for (let i = 0; i < outline.length; i++) {
    const [x, y] = outline[i];
    const lit = 1 - Math.min(1, Math.max(0, (x / outW + y / outH) / 2));
    ctx.strokeStyle = `rgba(255,255,255,${RIM.shade + (RIM.lit - RIM.shade) * lit * lit})`;
    seg(outline[i], outline[(i + 1) % outline.length]);
  }
  // 1b. The inner rim: the thickness of the glass.
  ctx.lineWidth = 1;
  const iw = outW - 2 * INNER_RIM.inset;
  const ih = outH - 2 * INNER_RIM.inset;
  for (let i = 0; i < inner.length; i++) {
    const [x, y] = inner[i];
    const lit = 1 - Math.min(1, Math.max(0, (x / iw + y / ih) / 2));
    ctx.strokeStyle = `rgba(255,255,255,${INNER_RIM.shade + (INNER_RIM.lit - INNER_RIM.shade) * lit * lit})`;
    seg(inner[i], inner[(i + 1) % inner.length], INNER_RIM.inset);
  }
  // 2. The moving light over the rim.
  for (const layer of GLOW_LAYERS) {
    ctx.lineWidth = layer.width;
    for (let i = 0; i < outline.length; i++) {
      const u = i / outline.length;
      const strength = intensityAt(frame, u);
      if (strength < GLOW_MIN_VISIBLE) continue;
      const cur = colorAt(u + frame.hueShift, activity.mode);
      const [r, g, b] = fade < 1 ? mixColors(colorAt(u + frame.hueShift, activity.prevMode), cur, fade) : cur;
      ctx.strokeStyle = `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${layer.alpha * strength})`;
      seg(outline[i], outline[(i + 1) % outline.length]);
    }
  }
}

function loop() {
  paintGlow();
  glowTimer = setTimeout(loop, GLOW_FRAME_MS);
}

let resizeQueued = false;
function reportHeight() {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => {
    resizeQueued = false;
    api.resize($('card').getBoundingClientRect().height);
  });
}

function close() {
  clearTimeout(glowTimer);
  stopPlayback();
  recorder?.stop().catch(() => {});
  $('root').classList.add('closing');
  setTimeout(() => api.close(), 110);
}

async function main() {
  cfg = {...cfg, ...(await api.init())};
  document.documentElement.style.setProperty('--pad', `${cfg.pad}px`);
  document.documentElement.style.setProperty('--radius', `${cfg.radius}px`);
  document.documentElement.style.setProperty('--answer-max', `${cfg.answerMax}px`);
  if (!cfg.material) $('root').classList.add('plain');
  recorder = new MicRecorder(() => toggleMic());
  $('entry').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') ask($('entry').value);
  });
  $('close').addEventListener('click', close);
  $('speaker').addEventListener('click', () => api.silence());
  $('mic').addEventListener('click', toggleMic);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
    else if (e.ctrlKey && (e.key === 'm' || e.key === 'M')) {
      e.preventDefault();
      toggleMic();
    }
  });
  api.onEvent(onEvent);
  api.onPlay(play);
  api.onStopPlayback(stopPlayback);
  new ResizeObserver(reportHeight).observe($('card'));
  reportHeight();
  loop();
  requestAnimationFrame(() => $('root').classList.add('shown'));
  $('entry').focus();
  api.ready();
}

main();
