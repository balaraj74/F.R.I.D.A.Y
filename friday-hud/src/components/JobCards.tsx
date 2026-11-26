import React, { useEffect, useState } from 'react';
import { AlertTriangle, Check, CircleHelp, Loader2, Layers } from 'lucide-react';
import { gateway } from '../services/gateway-ws';
import type { BackgroundJob } from '../types';

// Background jobs FRIDAY is working on: one compact card each with step progress, the question
// when she's waiting for Sir, and the report when done. Finished jobs stay visible for a while.

const RECENT_MS = 30 * 60_000;

// Written out in full so Tailwind keeps them.
const TONES = {
  cyan: { border: 'border-cyan-500/30', icon: 'text-cyan-300', bar: 'bg-cyan-400/80' },
  amber: { border: 'border-amber-500/40', icon: 'text-amber-300', bar: 'bg-amber-400/80' },
  rose: { border: 'border-rose-500/40', icon: 'text-rose-300', bar: 'bg-rose-400/80' },
  emerald: { border: 'border-emerald-500/30', icon: 'text-emerald-300', bar: 'bg-emerald-400/80' },
} as const;

const visible = (j: BackgroundJob) =>
  j.status === 'planning' || j.status === 'running' || j.status === 'waiting' ||
  ((j.status === 'done' || j.status === 'failed') && Date.now() - Date.parse(j.updatedAt) < RECENT_MS);

export const JobCards: React.FC = () => {
  const [jobs, setJobs] = useState<BackgroundJob[]>([]);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const load = () => void gateway.listJobs().then(setJobs);
    load();
    const offStatus = gateway.onStatus((up) => {
      if (up) load();
    });
    const offJob = gateway.onJob((job) =>
      setJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]),
    );
    return () => {
      offStatus();
      offJob();
    };
  }, []);

  const shown = jobs.filter(visible).slice(0, 3);
  if (!shown.length) return null;

  return (
    <div className="space-y-1.5">
      {shown.map((job) => {
        const done = job.steps.filter((s) => s.status === 'done').length;
        const total = job.steps.length;
        const current = job.steps.find((s) => s.status === 'running');
        const pct = total ? Math.round((done / total) * 100) : 0;
        const tone: keyof typeof TONES =
          job.status === 'waiting' ? 'amber' : job.status === 'failed' ? 'rose' : job.status === 'done' ? 'emerald' : 'cyan';
        const Icon =
          job.status === 'waiting' ? CircleHelp : job.status === 'failed' ? AlertTriangle : job.status === 'done' ? Check : Loader2;
        const line =
          job.status === 'planning' ? 'Planning the steps…'
          : job.status === 'waiting' ? job.question
          : job.status === 'done' || job.status === 'failed' ? job.report
          : current ? `Step ${job.steps.indexOf(current) + 1}/${total}: ${current.title}`
          : 'Working…';
        return (
          <div key={job.id} className={`rounded-xl border px-3 py-2 text-[11px] bg-slate-950/60 ${TONES[tone].border}`}>
            <button
              type="button"
              onClick={() => setOpen(open === job.id ? null : job.id)}
              className="w-full flex items-center gap-2 text-left"
              aria-expanded={open === job.id}
            >
              <Layers className="w-3.5 h-3.5 text-slate-500 shrink-0" />
              <span className="font-medium text-slate-200 truncate">{job.title}</span>
              <Icon className={`w-3.5 h-3.5 ml-auto shrink-0 ${TONES[tone].icon} ${job.status === 'running' || job.status === 'planning' ? 'animate-spin' : ''}`} />
              {total > 0 && <span className="font-mono text-[10px] text-slate-500 tabular-nums">{done}/{total}</span>}
            </button>
            {total > 0 && (
              <div className="mt-1.5 h-1 rounded-full bg-slate-800 overflow-hidden">
                <div className={`h-full ${TONES[tone].bar} transition-all`} style={{ width: `${pct}%` }} />
              </div>
            )}
            {line && <p className={`mt-1.5 leading-snug ${job.status === 'waiting' ? 'text-amber-200' : 'text-slate-400'} ${open === job.id ? '' : 'line-clamp-2'}`}>{line}</p>}
            {open === job.id && (
              <ol className="mt-2 space-y-1">
                {job.steps.map((s, i) => (
                  <li key={i} className="flex gap-2">
                    <span className={`mt-[5px] w-1.5 h-1.5 rounded-full shrink-0 ${s.status === 'done' ? 'bg-emerald-400' : s.status === 'running' ? 'bg-amber-300 animate-pulse' : s.status === 'failed' ? 'bg-rose-400' : 'bg-slate-600'}`} />
                    <span className="text-slate-300">
                      {s.title}
                      {s.summary && <span className="block text-slate-500">{s.summary}</span>}
                    </span>
                  </li>
                ))}
                <li className="pt-1 font-mono text-[10px] text-slate-500 break-all">{job.dir}</li>
              </ol>
            )}
          </div>
        );
      })}
    </div>
  );
};
