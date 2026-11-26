// Replayable turn trace (ROADMAP_V2 B3): rebuild what happened in a session — user messages,
// every tool call with its arguments, results/errors and timing, and the final reply — from
// the transcript JSONL the runner already writes. Nothing extra is logged.

export type TraceStep =
  | { kind: "user"; at: number; text: string }
  | {
      kind: "tool";
      at: number;
      id: string;
      name: string;
      args: unknown;
      durationMs?: number;
      isError?: boolean;
      result?: string;
    }
  | { kind: "reply"; at: number; text: string };

type Part = { type?: string; text?: string; id?: string; name?: string; arguments?: unknown };

const textOf = (content: unknown): string =>
  Array.isArray(content)
    ? (content as Part[])
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text)
        .join("\n")
    : typeof content === "string"
      ? content
      : "";

export function parseTrace(jsonl: string): TraceStep[] {
  const steps: TraceStep[] = [];
  const byCall = new Map<string, Extract<TraceStep, { kind: "tool" }>>();
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry: {
      type?: string;
      timestamp?: string;
      message?: {
        role?: string;
        content?: unknown;
        toolCallId?: string;
        isError?: boolean;
        timestamp?: number;
      };
    };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = entry.message;
    if (entry.type !== "message" || !msg) continue;
    const at =
      typeof msg.timestamp === "number" ? msg.timestamp : Date.parse(entry.timestamp ?? "") || 0;
    if (msg.role === "user") {
      const text = textOf(msg.content).trim();
      if (text) steps.push({ kind: "user", at, text });
    } else if (msg.role === "assistant") {
      const parts = Array.isArray(msg.content) ? (msg.content as Part[]) : [];
      for (const p of parts) {
        if (p?.type === "toolCall" && p.id && p.name) {
          const step = {
            kind: "tool" as const,
            at,
            id: p.id,
            name: p.name,
            args: p.arguments ?? {},
          };
          byCall.set(p.id, step);
          steps.push(step);
        }
      }
      const text = textOf(msg.content).trim();
      if (text) steps.push({ kind: "reply", at, text });
    } else if (msg.role === "toolResult" && msg.toolCallId) {
      const step = byCall.get(msg.toolCallId);
      if (step) {
        step.isError = msg.isError === true;
        step.result = textOf(msg.content);
        if (at && step.at) step.durationMs = Math.max(0, at - step.at);
      }
    }
  }
  return steps;
}

const clip = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

function argSummary(args: unknown): string {
  if (!args || typeof args !== "object") return clip(String(args ?? ""), 80);
  const o = args as Record<string, unknown>;
  for (const k of ["command", "query", "url", "path", "file_path", "phrase", "message", "to"]) {
    if (typeof o[k] === "string") return clip(o[k] as string, 80);
  }
  return clip(JSON.stringify(o), 80);
}

export function formatTrace(steps: TraceStep[], opts: { lastTurns?: number } = {}): string {
  let view = steps;
  if (opts.lastTurns) {
    const userIdx = steps.map((s, i) => (s.kind === "user" ? i : -1)).filter((i) => i >= 0);
    const from = userIdx.length > opts.lastTurns ? userIdx[userIdx.length - opts.lastTurns] : 0;
    view = steps.slice(from);
  }
  const time = (ms: number) => (ms ? new Date(ms).toLocaleTimeString() : "--:--:--");
  return view
    .map((s) => {
      if (s.kind === "user") return `\n${time(s.at)}  YOU   ${clip(s.text, 140)}`;
      if (s.kind === "reply") return `${time(s.at)}  FRIDAY ${clip(s.text, 140)}`;
      const status = s.result === undefined ? "no result" : s.isError ? "ERROR" : "ok";
      const dur = s.durationMs !== undefined ? ` ${(s.durationMs / 1000).toFixed(1)}s` : "";
      const res = s.result
        ? ` → ${clip(s.result.split("\n").find((l) => l.trim()) ?? "", 90)}`
        : "";
      return `${time(s.at)}    ↳ ${s.name}(${argSummary(s.args)}) [${status}${dur}]${res}`;
    })
    .join("\n")
    .trim();
}
