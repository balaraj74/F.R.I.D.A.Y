import React, { useState, useEffect } from 'react';
import { Clock, Play, RefreshCw, CheckCircle, AlertTriangle, Calendar, Zap } from 'lucide-react';
import { gateway } from '../services/gateway-ws';
import { CronJobItem } from '../types';

export const CronPanel: React.FC = () => {
  const [jobs, setJobs] = useState<CronJobItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [triggeringId, setTriggeringId] = useState<string | null>(null);

  const loadJobs = async () => {
    setLoading(true);
    try {
      const list = await gateway.getCronJobs();
      setJobs(list);
    } catch (e) {
      console.warn('Failed to load cron jobs:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadJobs();
    const timer = setInterval(loadJobs, 12000);
    return () => clearInterval(timer);
  }, []);

  const handleRunNow = async (job: CronJobItem) => {
    setTriggeringId(job.id);
    try {
      await gateway.runCronJob(job.id);
      setTimeout(loadJobs, 1500);
    } catch (e) {
      console.warn('Failed to force run cron job:', e);
    } finally {
      setTimeout(() => setTriggeringId(null), 1000);
    }
  };

  const handleToggle = async (job: CronJobItem) => {
    const nextState = !job.enabled;
    setJobs((prev) =>
      prev.map((j) => (j.id === job.id ? { ...j, enabled: nextState } : j))
    );
    try {
      await gateway.updateCronJob(job.id, nextState);
    } catch (e) {
      console.warn('Failed to update cron job:', e);
    }
  };

  const formatSchedule = (sch: CronJobItem['schedule']) => {
    if (sch.kind === 'every' && sch.everyMs) {
      const hours = sch.everyMs / 3600000;
      return `Every ${hours} hour${hours > 1 ? 's' : ''}`;
    }
    if (sch.kind === 'cron') {
      return `Cron (${sch.expr}) • ${sch.tz || 'Asia/Kolkata'}`;
    }
    return sch.kind;
  };

  return (
    <div className="flex-1 flex flex-col p-4 overflow-y-auto space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between pb-3 border-b border-cyan-500/20">
        <div>
          <h2 className="text-lg font-bold font-hud tracking-wider text-cyan-300 flex items-center gap-2">
            <Clock className="w-5 h-5 text-cyan-400 animate-pulse" />
            SCHEDULED AGENT AUTOMATIONS & BACKGROUND CRON
          </h2>
          <p className="text-xs font-mono text-slate-400">
            Autonomous proactive agent check-ins, briefings, and memory maintenance routines
          </p>
        </div>

        <button
          onClick={loadJobs}
          disabled={loading}
          className="px-3 py-1.5 rounded-xl border border-cyan-500/40 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 text-xs font-mono flex items-center gap-1.5 cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          REFRESH
        </button>
      </div>

      {/* Jobs List */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {jobs.map((job) => (
          <div
            key={job.id}
            className="p-4 rounded-2xl hud-glass-panel border border-cyan-500/30 flex flex-col justify-between space-y-3 hover:border-cyan-400/60 transition-all shadow-[0_0_20px_rgba(0,229,255,0.08)]"
          >
            <div>
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-2">
                  <div className="p-1.5 rounded-lg bg-cyan-500/20 text-cyan-300 border border-cyan-400/30">
                    <Zap className="w-4 h-4" />
                  </div>
                  <h3 className="font-bold font-hud text-slate-100 text-sm">{job.name}</h3>
                </div>

                <span
                  className={`px-2 py-0.5 rounded text-[10px] font-mono uppercase ${
                    job.enabled
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-400/40'
                      : 'bg-slate-800 text-slate-400'
                  }`}
                >
                  {job.enabled ? 'ACTIVE' : 'DISABLED'}
                </span>
              </div>

              <div className="text-[11px] font-mono text-cyan-300/90 flex items-center gap-1.5 mb-2">
                <Calendar className="w-3.5 h-3.5 text-cyan-400" />
                <span>{formatSchedule(job.schedule)}</span>
              </div>

              {job.payload?.message && (
                <div className="p-2 rounded-xl bg-slate-950/60 border border-cyan-500/20 text-[11px] font-mono text-slate-300 line-clamp-3">
                  {job.payload.message}
                </div>
              )}
            </div>

            <div className="pt-3 border-t border-cyan-500/15 flex items-center justify-between text-xs font-mono">
              <div className="text-[10px] text-slate-400">
                {job.state?.nextRunAtMs && (
                  <div>Next: {new Date(job.state.nextRunAtMs).toLocaleTimeString()}</div>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleToggle(job)}
                  className="px-2.5 py-1 rounded-lg border border-slate-700 hover:border-slate-500 text-slate-300 text-[10px] font-hud cursor-pointer"
                >
                  {job.enabled ? 'Disable' : 'Enable'}
                </button>

                <button
                  onClick={() => handleRunNow(job)}
                  disabled={triggeringId === job.id}
                  className="px-3 py-1 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/40 text-cyan-200 text-[10px] font-hud font-bold flex items-center gap-1 cursor-pointer transition-colors active:scale-95"
                >
                  <Play className={`w-3 h-3 ${triggeringId === job.id ? 'animate-spin' : ''}`} />
                  {triggeringId === job.id ? 'TRIGGERING...' : 'RUN NOW'}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

