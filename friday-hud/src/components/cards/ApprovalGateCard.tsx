import React, { useState } from 'react';
import { AlertTriangle, ShieldAlert, CheckCircle2, XCircle, Terminal } from 'lucide-react';

export interface ApprovalGateCardProps {
  id?: string;
  command: string;
  target?: string;
  riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  description?: string;
  onAuthorize?: (id?: string) => void;
  onDeny?: (id?: string) => void;
}

export const ApprovalGateCard: React.FC<ApprovalGateCardProps> = ({
  id,
  command,
  target,
  riskLevel = 'HIGH',
  description = 'Agent requested execution of an operational command requiring human sign-off.',
  onAuthorize,
  onDeny,
}) => {
  const [decision, setDecision] = useState<'pending' | 'authorized' | 'denied'>('pending');

  const handleAuthorize = () => {
    setDecision('authorized');
    onAuthorize?.(id);
  };

  const handleDeny = () => {
    setDecision('denied');
    onDeny?.(id);
  };

  const isHighRisk = riskLevel === 'HIGH' || riskLevel === 'CRITICAL';

  return (
    <div
      className={`w-full my-3 rounded-2xl border p-4 shadow-[0_8px_32px_rgba(0,0,0,0.7)] transition-all ${
        decision === 'authorized'
          ? 'bg-slate-950/90 border-emerald-500/50 shadow-[0_0_24px_rgba(16,185,129,0.2)]'
          : decision === 'denied'
          ? 'bg-slate-950/90 border-rose-500/50 shadow-[0_0_24px_rgba(244,63,94,0.2)]'
          : isHighRisk
          ? 'bg-gradient-to-br from-slate-950/95 via-amber-950/30 to-slate-900/90 border-amber-500/50 shadow-[0_0_25px_rgba(245,158,11,0.2)]'
          : 'bg-gradient-to-br from-slate-950/95 via-cyan-950/30 to-slate-900/90 border-cyan-500/40'
      }`}
    >
      {/* Header */}
      <div className="flex items-center justify-between pb-2 border-b border-white/10 mb-3">
        <div className="flex items-center gap-2">
          <div
            className={`p-1.5 rounded-lg ${
              isHighRisk ? 'bg-amber-500/20 text-amber-400' : 'bg-cyan-500/20 text-cyan-400'
            }`}
          >
            <ShieldAlert className="w-4 h-4 animate-pulse" />
          </div>
          <div>
            <span className="font-hud font-bold text-xs tracking-wider uppercase text-slate-100 flex items-center gap-2">
              SECURITY APPROVAL GATE
              <span
                className={`text-[9px] px-2 py-0.5 rounded font-mono font-bold ${
                  riskLevel === 'CRITICAL'
                    ? 'bg-red-950 border border-red-500 text-red-300'
                    : isHighRisk
                    ? 'bg-amber-950 border border-amber-500 text-amber-300'
                    : 'bg-cyan-950 border border-cyan-500 text-cyan-300'
                }`}
              >
                {riskLevel} RISK
              </span>
            </span>
          </div>
        </div>

        {decision !== 'pending' && (
          <span
            className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded-full flex items-center gap-1 ${
              decision === 'authorized'
                ? 'bg-emerald-950 text-emerald-400 border border-emerald-500'
                : 'bg-rose-950 text-rose-400 border border-rose-500'
            }`}
          >
            {decision === 'authorized' ? (
              <>
                <CheckCircle2 className="w-3 h-3" /> AUTHORIZED
              </>
            ) : (
              <>
                <XCircle className="w-3 h-3" /> DENIED
              </>
            )}
          </span>
        )}
      </div>

      <p className="text-[11px] font-mono text-slate-300 mb-2">{description}</p>

      {/* Target or command display */}
      <div className="rounded-xl bg-black/80 border border-white/10 p-3 mb-3 font-mono text-xs text-slate-200 overflow-x-auto">
        <div className="flex items-center gap-1.5 text-slate-400 text-[10px] mb-1">
          <Terminal className="w-3 h-3 text-cyan-400" />
          <span>PAYLOAD TO EXECUTE:</span>
          {target && <span className="text-cyan-300 truncate font-semibold">[{target}]</span>}
        </div>
        <code className="text-amber-200 block select-all whitespace-pre-wrap">{command}</code>
      </div>

      {/* Action Buttons */}
      {decision === 'pending' ? (
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            onClick={handleDeny}
            className="px-4 py-2 rounded-xl bg-slate-900 border border-rose-500/40 text-rose-300 font-hud text-xs font-bold hover:bg-rose-950/60 hover:border-rose-400 transition-all cursor-pointer flex items-center gap-1.5"
          >
            <XCircle className="w-3.5 h-3.5" />
            DENY
          </button>
          <button
            onClick={handleAuthorize}
            className="px-5 py-2 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-400 text-slate-950 font-hud text-xs font-bold hover:from-emerald-400 hover:to-white transition-all shadow-[0_0_18px_rgba(16,185,129,0.5)] cursor-pointer flex items-center gap-1.5"
          >
            <CheckCircle2 className="w-3.5 h-3.5 text-slate-950" />
            AUTHORIZE (EXECUTE)
          </button>
        </div>
      ) : (
        <div className="text-[10px] font-mono text-slate-400 italic">
          Decision recorded. Action dispatched to runner.
        </div>
      )}
    </div>
  );
};
