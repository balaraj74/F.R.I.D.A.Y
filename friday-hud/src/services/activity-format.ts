// Pure helpers for the live tool cards: what to show for a tool call at a glance.

import type { ActivityStep } from '../types';

export type ToolKind = 'shell' | 'search' | 'web' | 'file' | 'message' | 'memory' | 'other';

export function toolKind(name: string): ToolKind {
  const n = name.toLowerCase();
  if (/(exec|bash|shell|process|terminal|run)/.test(n)) return 'shell';
  if (/search/.test(n)) return 'search';
  if (/(fetch|browser|web|url|http)/.test(n)) return 'web';
  if (/(read|write|edit|file|patch|apply)/.test(n)) return 'file';
  if (/(message|whatsapp|telegram|send|email|notify)/.test(n)) return 'message';
  if (/(memory|recall|remember)/.test(n)) return 'memory';
  return 'other';
}

// The argument that tells you what the call is doing, in priority order.
const KEY_ARGS = ['command', 'cmd', 'query', 'q', 'url', 'path', 'file_path', 'filePath', 'to', 'target', 'message', 'text', 'action'];

export function argSummary(input: unknown, max = 90): string {
  if (input == null) return '';
  if (typeof input === 'string') return clip(input, max);
  if (typeof input !== 'object') return clip(String(input), max);
  const obj = input as Record<string, unknown>;
  for (const k of KEY_ARGS) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return clip(v, max);
    if (Array.isArray(v) && v.length) return clip(v.join(' '), max);
  }
  const json = JSON.stringify(obj);
  return json === '{}' ? '' : clip(json, max);
}

export function resultSummary(result: string | undefined, max = 120): string {
  if (!result) return '';
  const firstLine = result.split('\n').find((l) => l.trim()) ?? '';
  return clip(firstLine, max);
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/**
 * Group tool calls that started together (within `windowMs`) — the agent issued them in
 * parallel — so the HUD can show them side by side.
 */
export function groupParallel(steps: ActivityStep[], windowMs = 300): ActivityStep[][] {
  const tools = steps.filter((s) => s.type === 'action' && s.toolCall);
  const groups: ActivityStep[][] = [];
  for (const s of tools) {
    const start = s.toolCall!.startedAt ?? s.timestamp;
    const last = groups[groups.length - 1];
    const lastStart = last ? last[0].toolCall!.startedAt ?? last[0].timestamp : -Infinity;
    if (last && Math.abs(start - lastStart) <= windowMs) last.push(s);
    else groups.push([s]);
  }
  return groups;
}

/** The last complete sentence(s) of streaming reasoning, for a one-line "what she's thinking". */
export function reasoningTail(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const tail = flat.slice(-max);
  const cut = tail.search(/[.!?]\s+\S/);
  return '…' + (cut >= 0 && cut < max - 20 ? tail.slice(cut + 2) : tail);
}

function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}
