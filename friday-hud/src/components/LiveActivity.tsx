import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Brain, Check, ChevronDown, FileText, Globe, History, Lightbulb, MessageSquare, Search,
  ShieldAlert, Terminal, Wrench, X,
} from 'lucide-react';
import { gateway, type Thought } from '../services/gateway-ws';
import {
  argSummary, formatDuration, groupParallel, reasoningTail, resultSummary, toolKind, type ToolKind,
} from '../services/activity-format';
import type { ActivityStep, ExecApprovalRequest } from '../types';

// Live strip under the reactor: what FRIDAY is doing (tool cards), what she's thinking
// (reasoning + recalled/recorded lessons), and approvals she's waiting on. Every item comes
// from real gateway events; nothing here is decorative.

const ICONS: Record<ToolKind, React.FC<{ className?: string }>> = {
  shell: Terminal, search: Search, web: Globe, file: FileText, message: MessageSquare, memory: Brain, other: Wrench,
};

const LINGER_MS = 8000; // keep the last run visible briefly after it ends
const MAX_GROUPS = 4;

interface Props {
  compact?: boolean;
}

export const LiveActivity: React.FC<Props> = ({ compact = false }) => {
  const [steps, setSteps] = useState<ActivityStep[]>([]);
  const [reasoning, setReasoning] = useState('');
  const [notes, setNotes] = useState<Thought[]>([]);
  const [approvals, setApprovals] = useState<ExecApprovalRequest[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [lastEventAt, setLastEventAt] = useState(0);
  const prevCount = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const unsubs = [
      gateway.onActivity((_a, all) => {
        // A new run starts with a fresh activity list: drop the previous run's thoughts too.
        if (all.length <= 1 && prevCount.current > 1) { setNotes([]); setReasoning(''); }
        prevCount.current = all.length;
        setSteps(all);
        setLastEventAt(Date.now());
      }),
      gateway.onThought((t) => {
        if (t.kind === 'reasoning') setReasoning(t.text);
        else setNotes((prev) => [...prev.slice(-3), t]);
        setLastEventAt(Date.now());
      }),
      gateway.onApprovalRequested((req) => {
        setApprovals((prev) => [...prev.filter((a) => a.id !== req.id), req]);
        setLastEventAt(Date.now());
      }),
      gateway.onApprovalResolved((id) => setApprovals((prev) => prev.filter((a) => a.id !== id))),
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

  const running = steps.some((s) => s.status === 'running');
  // Auto-scroll to latest activity when new steps/thoughts arrive (unless a card is expanded).
  useEffect(() => {
    if (collapsed || expanded || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [steps.length, reasoning, notes.length, collapsed, expanded]);

  // Tick only while something is running or lingering, for live timers and the fade-out.
  useEffect(() => {
    if (!running && Date.now() - lastEventAt > LINGER_MS && approvals.length === 0) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [running, lastEventAt, approvals.length]);

  const groups = useMemo(() => groupParallel(steps), [steps]);
  const visible = running || approvals.length > 0 || now - lastEventAt < LINGER_MS;
  if (!visible || (groups.length === 0 && !reasoning && notes.length === 0 && approvals.length === 0)) return null;

  const shown = groups.slice(-MAX_GROUPS);
  const hiddenCount = groups.length - shown.length;
  const runningCount = steps.filter((s) => s.status === 'running').length;

  const resolve = async (id: string, decision: 'allow' | 'deny') => {
    try {
      await gateway.resolveApproval(id, decision);
    } catch (e) {
      console.warn('Approval failed:', e);
    }
    setApprovals((prev) => prev.filter((a) => a.id !== id));
  };

  return (
    <div className={`w-full max-w-2xl mx-auto flex flex-col gap-1.5 pointer-events-auto ${compact ? 'text-[10px]' : 'text-[11px]'} font-mono animate-fade-in`}>
      {/* Approvals first: she's blocked until you answer */}
      {approvals.map((a) => (
        <div key={a.id} className="flex items-center gap-2 px-3 py-2 rounded-xl border border-amber-400/60 bg-amber-950/85 backdrop-blur-md shadow-lg">
          <ShieldAlert className="w-4 h-4 text-amber-300 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-amber-200 font-bold tracking-wide">APPROVAL NEEDED · {a.toolName}</div>
            <div className="text-amber-100/80 truncate" title={a.command}>{a.command || argSummary(a.args)}</div>
          </div>
          <button type="button" onClick={() => void resolve(a.id, 'allow')} className="px-2 py-1 rounded-lg bg-emerald-500/25 border border-emerald-400/60 text-emerald-200 hover:bg-emerald-500/40 flex items-center gap-1">
            <Check className="w-3 h-3" /> Allow
          </button>
          <button type="button" onClick={() => void resolve(a.id, 'deny')} className="px-2 py-1 rounded-lg bg-rose-500/20 border border-rose-400/60 text-rose-200 hover:bg-rose-500/35 flex items-center gap-1">
            <X className="w-3 h-3" /> Deny
          </button>
        </div>
      ))}

      {(reasoning || notes.length > 0 || shown.length > 0) && (
        collapsed ? (
          <div className="flex justify-center">
            <button
              type="button"
              onClick={() => setCollapsed(false)}
              className="px-3 py-1 rounded-full border border-cyan-400/35 bg-slate-950/80 backdrop-blur-md text-cyan-200 hover:border-cyan-300/60 flex items-center gap-2 shadow-lg"
            >
              {runningCount > 0 && <span className="w-1.5 h-1.5 rounded-full bg-amber-300 animate-pulse" />}
              <span>
                {runningCount > 0
                  ? `${runningCount} running`
                  : reasoning
                  ? 'Thinking'
                  : `${steps.length} step${steps.length === 1 ? '' : 's'}`}
              </span>
              <ChevronDown className="w-3 h-3 rotate-180 text-cyan-400" />
            </button>
          </div>
        ) : (
          <div className="relative rounded-xl border border-cyan-500/20 bg-slate-950/75 backdrop-blur-md shadow-xl p-1.5 flex flex-col gap-1.5">
            <div className="flex items-center justify-between px-1.5 text-[10px] text-cyan-300/70">
              <span className="flex items-center gap-1.5">
                {runningCount > 0 && <span className="w-1.5 h-1.5 rounded-full bg-amber-300 animate-pulse" />}
                <span>{runningCount > 0 ? `LIVE · ${runningCount} RUNNING` : reasoning ? 'THINKING' : 'ACTIVITY'}</span>
              </span>
              <button
                type="button"
                onClick={() => setCollapsed(true)}
                className="hover:text-cyan-100 flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-slate-800/60"
                title="Minimize activity strip"
              >
                <span>Hide</span>
                <ChevronDown className="w-3 h-3" />
              </button>
            </div>

            <div
              ref={scrollRef}
              className={`flex flex-col gap-1.5 overflow-y-auto pr-0.5 ${compact ? 'max-h-28' : 'max-h-40'}`}
            >
              {/* Thought stream */}
              {(reasoning || notes.length > 0) && (
                <div className="px-3 py-1.5 rounded-xl border border-violet-400/25 bg-violet-950/35 text-violet-200/90 flex flex-col gap-1">
                  {reasoning && (
                    <div className="flex items-start gap-2">
                      <Brain className="w-3.5 h-3.5 mt-0.5 text-violet-300 flex-shrink-0" />
                      <span className="italic leading-snug">{reasoningTail(reasoning, compact ? 110 : 170)}</span>
                    </div>
                  )}
                  {notes.map((n, i) => (
                    <div key={`${n.ts}-${i}`} className="flex items-start gap-2 text-violet-200/75">
                      {n.kind === 'recall' ? (
                        <History className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                      ) : (
                        <Lightbulb className={`w-3.5 h-3.5 mt-0.5 flex-shrink-0 ${n.outcome === 'failure' ? 'text-rose-300' : 'text-amber-200'}`} />
                      )}
                      <span className="leading-snug">
                        <span className="opacity-70">{n.kind === 'recall' ? 'Recalled: ' : 'Lesson: '}</span>
                        {n.text}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* Tool cards */}
              {hiddenCount > 0 && <div className="text-cyan-400/60 px-1">+{hiddenCount} earlier step{hiddenCount > 1 ? 's' : ''}</div>}
              {shown.map((group) => (
                <div key={group[0].id} className={`flex gap-1.5 ${group.length > 1 ? 'items-stretch' : ''}`}>
                  {group.length > 1 && (
                    <div className="w-1 rounded-full bg-cyan-400/40" title={`${group.length} calls in parallel`} />
                  )}
                  <div className={`flex-1 grid gap-1.5 ${group.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}>
                    {group.map((s) => {
                      const tc = s.toolCall!;
                      const Icon = ICONS[toolKind(tc.name)];
                      const isRunning = s.status === 'running';
                      const isError = s.status === 'error' || tc.isError;
                      const elapsed = isRunning ? now - (tc.startedAt ?? s.timestamp) : tc.durationMs ?? s.durationMs;
                      const open = expanded === s.id;
                      return (
                        <button
                          key={s.id}
                          type="button"
                          onClick={() => setExpanded(open ? null : s.id)}
                          className={`text-left px-3 py-1.5 rounded-xl border transition-colors ${
                            isError
                              ? 'border-rose-400/50 bg-rose-950/40'
                              : isRunning
                              ? 'border-amber-400/50 bg-amber-950/35'
                              : 'border-cyan-500/25 bg-slate-900/65 hover:border-cyan-400/50'
                          }`}
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <Icon className={`w-3.5 h-3.5 flex-shrink-0 ${isError ? 'text-rose-300' : isRunning ? 'text-amber-300' : 'text-cyan-300'}`} />
                            <span className={`font-bold ${isError ? 'text-rose-200' : isRunning ? 'text-amber-200' : 'text-cyan-200'}`}>{tc.name}</span>
                            <span className="flex-1 min-w-0 truncate text-slate-400">{argSummary(tc.input)}</span>
                            {isRunning && <span className="w-1.5 h-1.5 rounded-full bg-amber-300 animate-pulse flex-shrink-0" />}
                            {elapsed != null && <span className="text-slate-500 tabular-nums flex-shrink-0">{formatDuration(elapsed)}</span>}
                            <ChevronDown className={`w-3 h-3 text-slate-500 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
                          </div>
                          {!open && !isRunning && tc.result && (
                            <div className={`mt-0.5 truncate ${isError ? 'text-rose-200/80' : 'text-slate-500'}`}>{resultSummary(tc.result)}</div>
                          )}
                          {open && (
                            <pre className="mt-1.5 max-h-36 overflow-auto whitespace-pre-wrap break-words text-[10px] text-slate-300 bg-slate-950/70 rounded-lg p-2">
                              {`args: ${JSON.stringify(tc.input ?? {}, null, 2)}${tc.result ? `\n\nresult:\n${tc.result.slice(0, 4000)}` : ''}`}
                            </pre>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      )}
    </div>
  );
};
