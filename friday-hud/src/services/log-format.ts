// Turn the gateway's structured JSON log lines into something a person can read.

export type LogLevel = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG' | 'TRACE' | 'OTHER';

export interface ParsedLog {
  time: string; // HH:MM:SS local
  level: LogLevel;
  subsystem: string;
  message: string;
  /** Structured fields (shown on expand). */
  details?: unknown;
  raw: string;
}

const LEVELS: LogLevel[] = ['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'];

export function parseLogLine(raw: string): ParsedLog {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw);
  } catch {
    return { time: '', level: /error/i.test(raw) ? 'ERROR' : /warn/i.test(raw) ? 'WARN' : 'OTHER', subsystem: '', message: raw, raw };
  }
  const meta = (obj._meta ?? {}) as { date?: string; logLevelName?: string; name?: string };
  const when = (obj.time as string) || meta.date;
  const d = when ? new Date(when) : null;
  const level = (LEVELS as string[]).includes(String(meta.logLevelName)) ? (meta.logLevelName as LogLevel) : 'OTHER';

  // Numbered parts: "0" is usually the subsystem JSON, strings are the message, objects are details.
  const parts = Object.keys(obj)
    .filter((k) => /^\d+$/.test(k))
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => obj[k]);
  let subsystem = '';
  const strings: string[] = [];
  const objects: unknown[] = [];
  for (const p of parts) {
    if (typeof p === 'string') {
      const sub = /^\{"subsystem":"([^"]+)"\}$/.exec(p);
      if (sub) subsystem = sub[1];
      else strings.push(p);
    } else if (p && typeof p === 'object') {
      objects.push(p);
    }
  }
  if (!subsystem && meta.name) subsystem = /"subsystem":"([^"]+)"/.exec(meta.name)?.[1] ?? '';

  return {
    time: d && !Number.isNaN(d.getTime()) ? d.toLocaleTimeString([], { hour12: false }) : '',
    level,
    subsystem,
    message: strings.join(' ') || (objects.length ? JSON.stringify(objects[0]).slice(0, 200) : ''),
    details: objects.length === 1 ? objects[0] : objects.length ? objects : undefined,
    raw,
  };
}
