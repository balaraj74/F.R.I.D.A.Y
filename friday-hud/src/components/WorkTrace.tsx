import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, Brain, Check, ChevronRight, FileText, Globe, Loader2, MessageSquare, PenLine, Search, Terminal, Wrench,
} from 'lucide-react';
import { formatDuration, resultSummary, toolKind, argSummary, type ToolKind } from '../services/activity-format';
import { toolPhrase } from '../services/narration';
import type { ActivityStep, ToolCallStep } from '../types';

// "How FRIDAY got there", in the order it happened: each thought, each note she wrote on the
// way, each tool with what went in and what came back. Folded to one line once the answer is
// in; open while she works.

const ICONS: Record<ToolKind, React.FC<{ className?: string }>> = {
  shell: Terminal, search: Search, web: Globe, file: FileText, message: MessageSquare, memory: Brain, other: Wrench,
};

interface Props {
  thinking?: string;
  toolCalls?: ToolCallStep[];
  activities?: ActivityStep[];
  isLive?: boolean;
  defaultExpanded?: boolean;
}

type Step =
  | { kind: 'thought'; id: string; text: string; durationMs?: number }
  | { kind: 'note'; id: string; text: string }
  | { kind: 'tool'; id: string; call: ToolCallStep };

function toSteps(thinking?: string, toolCalls?: ToolCallStep[], activities?: ActivityStep[]): Step[] {
  const fromActivities: Step[] = [];
  for (const a of activities ?? []) {
    if (a.type === 'thinking' && a.content?.trim()) {
      fromActivities.push({ kind: 'thought', id: a.id, text: a.content.trim(), durationMs: a.durationMs });
    } else if (a.type === 'text' && a.content?.trim()) {
      fromActivities.push({ kind: 'note', id: a.id, text: a.content.trim() });
    } else if (a.type === 'action' && a.toolCall) {
      fromActivities.push({ kind: 'tool', id: a.id, call: a.toolCall });
    }
  }
  if (fromActivities.length) return fromActivities;
  // Older history: only the flat thinking text and tool list are known.
  const steps: Step[] = [];
  if (thinking?.trim()) steps.push({ kind: 'thought', id: 'thought', text: thinking.trim() });
  for (const call of toolCalls ?? []) steps.push({ kind: 'tool', id: call.id, call });
  return steps;
}

const Rail: React.FC<{ tone: 'idle' | 'run' | 'ok' | 'err'; children: React.ReactNode }> = ({ tone, children }) => (
  <li className="relative pl-5">
    <span
      className={`absolute left-[-4.5px] top-[7px] w-2 h-2 rounded-full ring-2 ring-slate-950 ${
        tone === 'err' ? 'bg-rose-400' : tone === 'run' ? 'bg-amber-300 animate-pulse' : tone === 'ok' ? 'bg-emerald-400/90' : 'bg-slate-500'
      }`}
    />
    {children}
  </li>
);

const ThoughtStep: React.FC<{ text: string; durationMs?: number; live: boolean }> = ({ text, durationMs, live }) => {
  const [open, setOpen] = useState(live);
  useEffect(() => setOpen(live), [live]);
  const label = live ? 'Thinking' : durationMs && durationMs >= 1000 ? `Thought for ${formatDuration(durationMs)}` : 'Thought';
  return (
    <Rail tone={live ? 'run' : 'idle'}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex items-center gap-1.5 py-0.5 text-slate-400 hover:text-slate-200">
        <Brain className="w-3.5 h-3.5" />
        <span className={live ? 'text-amber-200' : ''}>{label}</span>
        <ChevronRight className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open ? (
        <p className="mt-0.5 mb-1 text-slate-400 leading-relaxed whitespace-pre-wrap max-h-56 overflow-y-auto hud-scroll">{text}</p>
      ) : (
        <p className="text-slate-500 truncate">{text.replace(/\s+/g, ' ')}</p>
      )}
    </Rail>
  );
};

const ToolStep: React.FC<{ call: ToolCallStep; now: number }> = ({ call, now }) => {
  const [open, setOpen] = useState(false);
  const Icon = ICONS[toolKind(call.name)];
  const running = call.status === 'running';
  const failed = call.status === 'error' || Boolean(call.isError);
  const elapsed = running ? now - (call.startedAt ?? now) : call.durationMs;
  const input = JSON.stringify(call.input ?? {}, null, 2);
  return (
    <Rail tone={failed ? 'err' : running ? 'run' : 'ok'}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="w-full flex items-center gap-2 py-0.5 text-left rounded hover:bg-cyan-500/5">
        {running ? <Loader2 className="w-3.5 h-3.5 shrink-0 text-amber-300 animate-spin" /> : <Icon className={`w-3.5 h-3.5 shrink-0 ${failed ? 'text-rose-300' : 'text-cyan-300'}`} />}
        <span className={`shrink-0 ${failed ? 'text-rose-200' : running ? 'text-amber-100' : 'text-slate-200'}`}>{toolPhrase(call.name, call.input, !running)}</span>
        <span className="font-mono text-[10px] text-slate-500 truncate min-w-0">{argSummary(call.input, 70)}</span>
        {elapsed != null && <span className="ml-auto pl-2 font-mono text-[10px] text-slate-500 tabular-nums shrink-0">{formatDuration(elapsed)}</span>}
      </button>
      {!open && !running && call.result && (
        <p className={`font-mono text-[10px] truncate ${failed ? 'text-rose-300/80' : 'text-slate-500'}`}>↳ {resultSummary(call.result, 140)}</p>
      )}
      {open && (
        <div className="mt-1 mb-1.5 rounded-lg border border-slate-800 bg-slate-900/80 text-[10px] font-mono overflow-hidden">
          <div className="px-2 py-1 border-b border-slate-800 text-slate-500">{call.name} · input</div>
          <pre className="px-2 py-1.5 text-slate-300 whitespace-pre-wrap break-words max-h-40 overflow-auto hud-scroll">{input}</pre>
          {call.result && (
            <>
              <div className={`px-2 py-1 border-y border-slate-800 ${failed ? 'text-rose-300' : 'text-slate-500'}`}>{failed ? 'error' : 'output'}</div>
              <pre className="px-2 py-1.5 text-slate-300 whitespace-pre-wrap break-words max-h-64 overflow-auto hud-scroll">{call.result.slice(0, 8000)}</pre>
            </>
          )}
        </div>
      )}
    </Rail>
  );
};

export const WorkTrace: React.FC<Props> = ({ thinking, toolCalls, activities, isLive = false, defaultExpanded }) => {
  const steps = useMemo(() => toSteps(thinking, toolCalls, activities), [thinking, toolCalls, activities]);
  const [open, setOpen] = useState(defaultExpanded ?? isLive);
  useEffect(() => {
    if (isLive) setOpen(true);
  }, [isLive]);

  const tools = steps.filter((s): s is Extract<Step, { kind: 'tool' }> => s.kind === 'tool');
  const running = tools.find((s) => s.call.status === 'running');
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [running]);

  if (!steps.length) return null;

  const errors = tools.filter((s) => s.call.status === 'error' || s.call.isError).length;
  const thoughtMs = steps.reduce((sum, s) => sum + (s.kind === 'thought' ? s.durationMs ?? 0 : 0), 0);
  const toolMs = tools.reduce((sum, s) => sum + (s.call.durationMs ?? 0), 0);
  const thoughts = steps.filter((s) => s.kind === 'thought').length;
  const last = steps[steps.length - 1];
  const thinkingNow = isLive && !running && last.kind === 'thought';

  const parts: string[] = [];
  if (thoughts) parts.push(thoughtMs >= 1000 ? `Thought for ${formatDuration(thoughtMs)}` : 'Thought it through');
  if (tools.length) parts.push(`${tools.length} tool${tools.length === 1 ? '' : 's'}${toolMs >= 1000 ? ` · ${formatDuration(toolMs)}` : ''}`);
  if (errors) parts.push(`${errors} failed`);
  const summary = running ? `${toolPhrase(running.call.name, running.call.input)}…` : thinkingNow ? 'Thinking…' : parts.join(' · ');

  return (
    <div className="w-full text-[11px]">
      {/* While live, the working card above already says what's happening now. */}
      {!isLive && <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1.5 py-1 text-left text-slate-400 hover:text-slate-200"
      >
        {running || thinkingNow ? (
          <Loader2 className="w-3.5 h-3.5 text-amber-300 animate-spin shrink-0" />
        ) : errors ? (
          <AlertTriangle className="w-3.5 h-3.5 text-rose-300 shrink-0" />
        ) : (
          <Check className="w-3.5 h-3.5 text-emerald-300/90 shrink-0" />
        )}
        <span className={running ? 'text-amber-200' : ''}>{summary}</span>
        <ChevronRight className={`w-3.5 h-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>}

      {(open || isLive) && (
        <ol className="ml-[6px] mt-0.5 mb-1.5 border-l border-slate-700/70 space-y-1">
          {steps.map((s, i) => {
            if (s.kind === 'thought') {
              return <ThoughtStep key={s.id} text={s.text} durationMs={s.durationMs} live={thinkingNow && i === steps.length - 1} />;
            }
            if (s.kind === 'note') {
              return (
                <Rail key={s.id} tone="idle">
                  <p className="flex gap-1.5 py-0.5 text-slate-300 leading-relaxed">
                    <PenLine className="w-3.5 h-3.5 mt-[1px] shrink-0 text-slate-500" />
                    <span className="whitespace-pre-wrap">{s.text}</span>
                  </p>
                </Rail>
              );
            }
            return <ToolStep key={s.id} call={s.call} now={now} />;
          })}
        </ol>
      )}
    </div>
  );
};
