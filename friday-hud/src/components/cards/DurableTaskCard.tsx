import React, { useState } from 'react';
import { Cpu, CheckCircle2, Pause, Play, XCircle, RotateCcw, Clock } from 'lucide-react';

export interface DurableTaskCardProps {
  id: string;
  category: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'paused' | 'cancelled';
  retryCount?: number;
  maxRetries?: number;
  resultSnippet?: string;
  onPause?: (id: string) => void;
  onResume?: (id: string) => void;
  onCancel?: (id: string) => void;
}

export const DurableTaskCard: React.FC<DurableTaskCardProps> = ({
  id,
  category,
  status: initialStatus,
  retryCount = 0,
  maxRetries = 3,
  resultSnippet,
  onPause,
  onResume,
  onCancel,
}) => {
  const [status, setStatus] = useState(initialStatus);

  const handlePause = () => {
    setStatus('paused');
    onPause?.(id);
  };

  const handleResume = () => {
    setStatus('running');
    onResume?.(id);
  };

  const handleCancel = () => {
    setStatus('cancelled');
    onCancel?.(id);
  };

  const isRunning = status === 'running';

  return (
    <div className="w-full my-3 rounded-2xl bg-gradient-to-br from-slate-950/90 via-slate-900/90 to-cyan-950/30 border border-cyan-500/35 p-3.5 shadow-[0_8px_32px_rgba(0,0,0,0.6)]">
      {/* Header */}
      <div className="flex items-center justify-between pb-2 border-b border-cyan-500/20 mb-2.5">
        <div className="flex items-center gap-2 overflow-hidden">
          <div className="p-1.5 rounded-lg bg-cyan-500/20 text-cyan-400">
            <Cpu className={`w-3.5 h-3.5 ${isRunning ? 'animate-spin' : ''}`} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-hud font-bold text-xs uppercase text-cyan-200 truncate">
                {category}
              </span>
              <span className="text-[9px] font-mono text-slate-500">[{id}]</span>
            </div>
          </div>
        </div>

        {/* Status Badge */}
        <div className="flex items-center gap-2 shrink-0">
          <span
            className={`text-[9px] font-mono font-bold px-2 py-0.5 rounded-full flex items-center gap-1 ${
              status === 'completed'
                ? 'bg-emerald-950 text-emerald-400 border border-emerald-500/40'
                : status === 'failed'
                ? 'bg-rose-950 text-rose-400 border border-rose-500/40'
                : status === 'paused'
                ? 'bg-amber-950 text-amber-400 border border-amber-500/40'
                : status === 'cancelled'
                ? 'bg-slate-900 text-slate-400 border border-slate-700'
                : 'bg-cyan-950 text-cyan-300 border border-cyan-500/40 animate-pulse'
            }`}
          >
            {status.toUpperCase()}
          </span>
        </div>
      </div>

      {/* Progress / Heartbeat Telemetry */}
      <div className="space-y-1.5 mb-2.5">
        <div className="flex items-center justify-between text-[10px] font-mono text-slate-400">
          <span className="flex items-center gap-1">
            <Clock className="w-3 h-3 text-cyan-400" />
            Worker Lease: {isRunning ? 'Active Heartbeat (15s)' : 'Inactive'}
          </span>
          <span>Retries: {retryCount}/{maxRetries}</span>
        </div>

        {/* Progress bar */}
        <div className="w-full h-1.5 rounded-full bg-slate-900 overflow-hidden border border-cyan-500/20">
          <div
            className={`h-full transition-all duration-300 ${
              status === 'completed'
                ? 'w-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]'
                : status === 'failed'
                ? 'w-full bg-rose-500'
                : status === 'paused'
                ? 'w-1/2 bg-amber-400'
                : 'w-3/4 bg-cyan-400 animate-pulse shadow-[0_0_8px_rgba(0,229,255,0.8)]'
            }`}
          />
        </div>
      </div>

      {/* Result snippet if completed */}
      {resultSnippet && (
        <div className="p-2 rounded-lg bg-black/70 border border-cyan-500/20 font-mono text-[10px] text-slate-300 mb-2 truncate">
          Result: {resultSnippet}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center justify-end gap-1.5">
        {isRunning && (
          <button
            onClick={handlePause}
            className="px-2.5 py-1 rounded-lg bg-amber-950/40 border border-amber-500/40 text-amber-300 hover:bg-amber-500/20 text-[10px] font-mono flex items-center gap-1 transition-colors cursor-pointer"
          >
            <Pause className="w-2.5 h-2.5" /> Pause
          </button>
        )}
        {status === 'paused' && (
          <button
            onClick={handleResume}
            className="px-2.5 py-1 rounded-lg bg-cyan-950/40 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/20 text-[10px] font-mono flex items-center gap-1 transition-colors cursor-pointer"
          >
            <Play className="w-2.5 h-2.5" /> Resume
          </button>
        )}
        {(isRunning || status === 'paused') && (
          <button
            onClick={handleCancel}
            className="px-2.5 py-1 rounded-lg bg-rose-950/40 border border-rose-500/40 text-rose-300 hover:bg-rose-500/20 text-[10px] font-mono flex items-center gap-1 transition-colors cursor-pointer"
          >
            <XCircle className="w-2.5 h-2.5" /> Cancel
          </button>
        )}
      </div>
    </div>
  );
};
