import React, { useCallback, useEffect, useState } from 'react';
import { Check, Dna, FlaskConical, Loader2, RotateCcw, X } from 'lucide-react';
import { gateway } from '../services/gateway-ws';

// FRIDAY's real evolution: changes she proposed from real evidence, tested blind, and only
// applied when Sir approves. Every number here is counted, none is decorative.

type Proposal = {
  id: string;
  createdAt: string;
  title: string;
  why: string;
  instruction: string;
  evidence: string;
  status: 'pending' | 'applied' | 'rejected' | 'undone' | 'failed-test';
  score?: { before: number; after: number; regressionBefore: number; regressionAfter: number };
  benchmark?: { graded: number; verdict: string };
};
type State = {
  generation: number;
  lastRunAt?: string;
  lastSummary?: string;
  proposals: Proposal[];
  benchmarkHistory?: { at: string; score: number }[];
};

const Stat: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="p-3.5 rounded-xl border border-cyan-500/25 bg-slate-900/60">
    <div className="text-[10px] font-mono text-cyan-400/90 tracking-wider">{label}</div>
    <div className="text-2xl font-bold font-hud text-slate-100 mt-1">{value}</div>
  </div>
);

export const EvolutionPanel: React.FC = () => {
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    try {
      setState(await gateway.request<State>('evolution.status', {}));
    } catch {
      setNotice('FRIDAY is offline, so evolution data is unavailable.');
    }
  }, []);
  useEffect(() => {
    void refresh();
    return gateway.onEvolution(() => void refresh());
  }, [refresh]);

  const runNow = async () => {
    setBusy(true);
    setNotice('Reviewing today and testing ideas. This can take a few minutes…');
    try {
      const res = await gateway.request<State & { summary: string }>('evolution.run', {});
      setState(res);
      setNotice(res.summary);
    } catch (e: any) {
      setNotice(e?.message || 'The review failed.');
    } finally {
      setBusy(false);
    }
  };

  const decide = async (id: string, action: 'approve' | 'reject' | 'undo') => {
    try {
      setState(await gateway.request<State>('evolution.decide', { id, action }));
    } catch (e: any) {
      setNotice(e?.message || 'That did not work.');
    }
  };

  const list = state?.proposals ?? [];
  const pending = list.filter((p) => p.status === 'pending');
  const applied = list.filter((p) => p.status === 'applied');
  const others = list.filter((p) => !['pending', 'applied'].includes(p.status)).slice(-8).reverse();

  const Score: React.FC<{ p: Proposal }> = ({ p }) =>
    p.score ? (
      <div className="text-[11px] font-mono text-slate-400">
        Own test {p.score.before} → <span className="text-emerald-300">{p.score.after}</span>
        {p.benchmark && (
          <>
            {' '}· benchmark ({p.benchmark.graded} tasks) {p.score.regressionBefore} → {p.score.regressionAfter} · {p.benchmark.verdict}
          </>
        )}
      </div>
    ) : null;

  return (
    <div className="flex-1 flex flex-col h-full overflow-y-auto p-6 gap-5">
      <div className="flex items-center justify-between gap-4 pb-4 border-b border-cyan-500/20">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-cyan-500/15 border border-cyan-400/40 text-cyan-300">
            <Dna className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-lg font-bold font-hud text-slate-100">EVOLUTION</h2>
            <p className="text-xs text-slate-400">Once a day, while you're idle, FRIDAY reviews what went wrong and proposes tested changes. Nothing changes without your OK.</p>
          </div>
        </div>
        <button
          onClick={runNow}
          disabled={busy}
          className="shrink-0 flex items-center gap-2 px-4 py-2 rounded-xl border border-cyan-400/50 text-cyan-200 text-xs font-hud hover:bg-cyan-500/10 disabled:opacity-50 cursor-pointer"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <FlaskConical className="w-4 h-4" />}
          REVIEW NOW
        </button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Stat label="GENERATION" value={state?.generation ?? '—'} />
        <Stat label="WAITING FOR YOU" value={state ? pending.length : '—'} />
        <Stat label="ACTIVE RULES" value={state ? applied.length : '—'} />
        <Stat
          label="BENCHMARK"
          value={(() => {
            const h = state?.benchmarkHistory ?? [];
            if (!h.length) return '—';
            const last = h[h.length - 1].score;
            const prev = h.length > 1 ? h[h.length - 2].score : null;
            return (
              <span>
                {last}/10
                {prev !== null && last !== prev && (
                  <span className={`ml-1 text-sm ${last > prev ? 'text-emerald-300' : 'text-rose-300'}`}>
                    {last > prev ? '▲' : '▼'} {Math.abs(Math.round((last - prev) * 10) / 10)}
                  </span>
                )}
              </span>
            );
          })()}
        />
        <Stat label="LAST REVIEW" value={<span className="text-sm">{state?.lastRunAt ? new Date(state.lastRunAt).toLocaleString() : 'Not yet'}</span>} />
      </div>

      {(notice || state?.lastSummary) && <p className="text-sm text-slate-300">{notice || state?.lastSummary}</p>}

      {pending.length > 0 && (
        <section className="flex flex-col gap-3">
          <h3 className="text-xs font-hud text-amber-200 tracking-wider">WAITING FOR YOUR DECISION</h3>
          {pending.map((p) => (
            <div key={p.id} className="p-4 rounded-xl border border-amber-400/30 bg-slate-900/60 flex flex-col gap-2">
              <div className="font-bold text-slate-100">{p.title}</div>
              <p className="text-sm text-slate-300">{p.why}</p>
              {p.evidence && <p className="text-xs italic text-slate-400">“{p.evidence}”</p>}
              <p className="text-sm text-cyan-100 border-l-2 border-cyan-400/60 pl-3">{p.instruction}</p>
              <Score p={p} />
              <div className="flex gap-2 mt-1">
                <button onClick={() => decide(p.id, 'approve')} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/20 border border-emerald-400/50 text-emerald-200 text-xs cursor-pointer hover:bg-emerald-500/30">
                  <Check className="w-3.5 h-3.5" /> Approve
                </button>
                <button onClick={() => decide(p.id, 'reject')} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-600 text-slate-300 text-xs cursor-pointer hover:bg-slate-800">
                  <X className="w-3.5 h-3.5" /> Reject
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      {applied.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-hud text-emerald-200 tracking-wider">ACTIVE RULES</h3>
          {applied.map((p) => (
            <div key={p.id} className="p-3 rounded-xl border border-emerald-500/20 bg-slate-900/50 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm text-slate-200">{p.instruction}</div>
                <Score p={p} />
              </div>
              <button onClick={() => decide(p.id, 'undo')} className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-600 text-slate-300 text-xs cursor-pointer hover:bg-slate-800">
                <RotateCcw className="w-3.5 h-3.5" /> Undo
              </button>
            </div>
          ))}
        </section>
      )}

      {others.length > 0 && (
        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-hud text-slate-400 tracking-wider">HISTORY</h3>
          {others.map((p) => (
            <div key={p.id} className="text-xs text-slate-400 flex justify-between gap-3">
              <span className="truncate">{p.title}</span>
              <span className="font-mono shrink-0">{p.status === 'failed-test' ? 'failed test' : p.status}</span>
            </div>
          ))}
        </section>
      )}

      {state && list.length === 0 && <p className="text-sm text-slate-400">No proposals yet. The honest count starts at generation 0.</p>}
    </div>
  );
};
