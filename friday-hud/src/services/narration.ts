// Human phrasing for tool calls, shared by the chat trace (labels) and FRIDAY's spoken
// progress narration, so what she says always matches what the screen shows.

import { argSummary, toolKind } from './activity-format';
import { gateway } from './gateway-ws';
import { fastBrain } from './fast-brain';
import { speechService } from './speech';
import type { ActivityStep } from '../types';

const short = (s: string, words = 6) => {
  const w = s.replace(/[`"'*_]/g, '').split(/\s+/).filter(Boolean);
  return w.length > words ? `${w.slice(0, words).join(' ')}…` : w.join(' ');
};

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

/** Present-tense phrase while running ("Searching for …"), past tense when done ("Searched for …"). */
export function toolPhrase(name: string, input: unknown, done = false): string {
  const arg = argSummary(input, 200);
  const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const n = name.toLowerCase();
  if (n === 'memory_search') return `${done ? 'Checked' : 'Checking'} my memory${arg ? ` for ${short(arg, 5)}` : ''}`;
  if (n === 'memory_forget') return done ? 'Forgot it' : 'Forgetting that';
  if (n === 'swarm') {
    const count = Array.isArray(obj.agents) ? obj.agents.length : 0;
    return `${done ? 'Coordinated' : 'Coordinating'} ${count || 'several'} agents`;
  }
  if (n === 'run_code') return done ? 'Ran some code' : 'Running some code in my sandbox';
  if (n === 'commitments') return `${done ? 'Checked' : 'Checking'} your commitments`;
  if (n === 'knowledge') return `${done ? 'Checked' : 'Checking'} what I know${obj.name ? ` about ${short(String(obj.name), 4)}` : ''}`;
  if (n === 'files') {
    if (obj.action === 'search') return `${done ? 'Searched' : 'Searching'} your files${obj.query ? ` for ${short(String(obj.query), 5)}` : ''}`;
    return done ? 'Checked your folders' : 'Checking your folders';
  }
  if (n === 'jobs') {
    if (obj.action === 'start') return `${done ? 'Started' : 'Starting'} a background job${obj.title ? `: ${short(String(obj.title), 5)}` : ''}`;
    return done ? 'Checked the jobs' : 'Checking the jobs';
  }
  if (n === 'code') {
    const verb: Record<string, [string, string]> = {
      start: ['Setting up a branch', 'Set up a branch'],
      test: ['Running the tests', 'Ran the tests'],
      review: ['Reviewing the changes', 'Reviewed the changes'],
      merge: ['Merging', 'Merged'],
      discard: ['Discarding the branch', 'Discarded the branch'],
    };
    const [now, past] = verb[String(obj.action)] ?? ['Checking coding tasks', 'Checked coding tasks'];
    return done ? past : now;
  }
  if (n === 'mcp_desktop_screen_look') return done ? 'Looked at your screen' : 'Looking at your screen';
  if (n === 'mcp_desktop_screen_click') return done ? 'Clicked' : 'Clicking';
  if (n === 'mcp_desktop_screen_type') return done ? 'Typed it in' : 'Typing';
  if (n === 'mcp_desktop_screen_key') return `${done ? 'Pressed' : 'Pressing'} ${short(String(obj.keys ?? 'a key'), 3)}`;
  if (n === 'mcp_desktop_screen_scroll') return done ? 'Scrolled' : 'Scrolling';
  switch (toolKind(name)) {
    case 'search':
      return `${done ? 'Searched' : 'Searching'} for ${short(arg, 6) || 'that'}`;
    case 'web': {
      const host = hostOf(String(obj.url ?? arg));
      return `${done ? 'Read' : 'Reading'} ${host || 'a web page'}`;
    }
    case 'shell':
      return done ? 'Ran a command' : 'Running a command';
    case 'file': {
      const file = String(obj.path ?? obj.file_path ?? arg).split('/').pop() || 'a file';
      const writing = /write|edit|patch|apply/.test(n);
      return writing ? `${done ? 'Updated' : 'Updating'} ${file}` : `${done ? 'Read' : 'Reading'} ${file}`;
    }
    case 'message':
      return done ? 'Sent a message' : 'Sending a message';
    case 'memory':
      return done ? 'Checked my memory' : 'Checking my memory';
    default: {
      // MCP tools arrive as mcp_<server>_<tool>: say "Using github list issues", not "mcp …".
      const label = name.replace(/^mcp_/, '').replace(/_/g, ' ');
      return `${done ? 'Used' : 'Using'} ${label}`;
    }
  }
}

// --- Spoken progress -----------------------------------------------------------------
// Only for tools that are still running after a moment, at most one line every 7 s, and
// never over Sir or over FRIDAY's own reply.
const SPEAK_AFTER_MS = 1500;
const MIN_GAP_MS = 7000;
let lastSpokenAt = 0;
const seen = new Set<string>();

function maybeNarrate(step: ActivityStep) {
  if (step.type !== 'action' || !step.toolCall || step.status !== 'running' || seen.has(step.id)) return;
  seen.add(step.id);
  const id = step.id;
  setTimeout(() => {
    const still = gateway.currentActivities().find((a) => a.id === id);
    if (!still || still.status !== 'running') return;
    if (replyStarted || speechService.isVoiceMuted() || speechService.getIsListening() || speechService.getIsSpeaking()) return;
    if (Date.now() - lastSpokenAt < MIN_GAP_MS) return;
    lastSpokenAt = Date.now();
    spokeThisTurn = true;
    speechService.sayInterim(`${toolPhrase(still.toolCall!.name, still.toolCall!.input)}.`);
  }, SPEAK_AFTER_MS);
}

// --- Turn-level voice: the fast brain's acknowledgement, then filler if it's slow ------------
const ACK_SPEAK_AFTER_MS = 5000;
let turnTimers: ReturnType<typeof setTimeout>[] = [];
let turnActive = false;
let turnId = 0;
let replyStarted = false;
let spokeThisTurn = false;

// What FRIDAY said she's doing this turn (the WorkingCard shows it as its headline).
let headline = '';
const headlineListeners = new Set<(h: string) => void>();
function setHeadline(h: string) {
  headline = h;
  headlineListeners.forEach((cb) => cb(h));
}
export function onTurnHeadline(cb: (h: string) => void): () => void {
  headlineListeners.add(cb);
  cb(headline);
  return () => headlineListeners.delete(cb);
}

function canSpeak() {
  return turnActive && !replyStarted && !speechService.isVoiceMuted() && !speechService.getIsListening() && !speechService.getIsSpeaking();
}

function quietSay(line: string) {
  if (!canSpeak()) return;
  if (Date.now() - lastSpokenAt < MIN_GAP_MS) return;
  lastSpokenAt = Date.now();
  spokeThisTurn = true;
  speechService.sayInterim(line);
}

/** Call when Sir sends a message: the fast brain's acknowledgement, a filler if that's slow, one nudge if it's long. */
export function narrateTurnStart(text = '') {
  narrateTurnEnd();
  turnActive = true;
  replyStarted = false;
  spokeThisTurn = false;
  const id = ++turnId;
  const startedAt = Date.now();
  if (text.trim()) {
    void fastBrain.ackFor(text).then((ack) => {
      if (id !== turnId || !turnActive || !ack) return;
      setHeadline(ack);
      // Replies usually start within seconds: only speak it if she'd otherwise stay silent.
      const wait = Math.max(0, ACK_SPEAK_AFTER_MS - (Date.now() - startedAt));
      turnTimers.push(
        setTimeout(() => {
          if (id !== turnId || spokeThisTurn || !canSpeak()) return;
          lastSpokenAt = Date.now();
          spokeThisTurn = true;
          speechService.sayInterim(ack);
        }, wait),
      );
    });
  }
  turnTimers = [
    setTimeout(() => !spokeThisTurn && quietSay('On it.'), 8000),
    setTimeout(() => {
      if (!gateway.currentActivities().some((a) => a.type === 'action')) quietSay('Still working on it.');
    }, 25000),
  ];
}

/** Call when the first words of the reply arrive: from here on her answer does the talking. */
export function narrateReplyStarted() {
  replyStarted = true;
}

/** Call when the reply is done (or aborted). */
export function narrateTurnEnd() {
  turnActive = false;
  turnTimers.forEach(clearTimeout);
  turnTimers = [];
  if (headline) setHeadline('');
}

let started = false;
/** Start narrating tool progress (idempotent). Returns a stop function. */
export function startNarration(): () => void {
  if (started) return () => {};
  started = true;
  const unsub = gateway.onActivity((step, all) => {
    if (all.length <= 1) seen.clear(); // new run
    maybeNarrate(step);
  });
  return () => {
    started = false;
    unsub();
  };
}
