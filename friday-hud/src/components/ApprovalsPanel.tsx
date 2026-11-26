import React, { useState, useEffect } from 'react';
import { ShieldCheck, ShieldAlert, Check, X, RefreshCw, Terminal, Lock } from 'lucide-react';
import { gateway } from '../services/gateway-ws';
import { ExecApprovalRequest } from '../types';

export const ApprovalsPanel: React.FC = () => {
  const [approvals, setApprovals] = useState<ExecApprovalRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [socketInfo, setSocketInfo] = useState<string>('~/.friday/exec-approvals.sock');

  const loadApprovals = async () => {
    setLoading(true);
    try {
      const data = await gateway.getApprovals();
      if (data?.file?.socket?.path) {
        setSocketInfo(data.file.socket.path);
      }
      // If any pending approvals exist in payload
      if (Array.isArray(data?.pending)) {
        setApprovals(data.pending);
      }
    } catch (e) {
      console.warn('Failed to load approvals:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadApprovals();
    const unsub = gateway.onApprovalRequested((req) => {
      setApprovals((prev) => [req, ...prev]);
    });
    return () => unsub();
  }, []);

  const handleResolve = async (id: string, decision: 'allow' | 'deny') => {
    try {
      await gateway.resolveApproval(id, decision);
      setApprovals((prev) =>
        prev.map((a) => (a.id === id ? { ...a, status: decision === 'allow' ? 'allowed' : 'denied' } : a))
      );
    } catch (e) {
      console.warn('Failed to resolve approval:', e);
    }
  };

  return (
    <div className="flex-1 flex flex-col p-4 overflow-y-auto space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between pb-3 border-b border-cyan-500/20">
        <div>
          <h2 className="text-lg font-bold font-hud tracking-wider text-cyan-300 flex items-center gap-2">
            <Lock className="w-5 h-5 text-cyan-400 animate-pulse" />
            SECURITY GATEKEEPER & COMMAND APPROVALS
          </h2>
          <p className="text-xs font-mono text-slate-400">
            Real-time human-in-the-loop authorization for sensitive bash, filesystem & network actions
          </p>
        </div>

        <button
          onClick={loadApprovals}
          disabled={loading}
          className="px-3 py-1.5 rounded-xl border border-cyan-500/40 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 text-xs font-mono flex items-center gap-1.5 cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          REFRESH
        </button>
      </div>

      {/* Security Status Card */}
      <div className="p-4 rounded-2xl hud-glass-panel border border-cyan-500/30 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-cyan-500/20 text-cyan-300 border border-cyan-400/30">
            <ShieldCheck className="w-6 h-6" />
          </div>
          <div>
            <h3 className="font-bold font-hud text-slate-100 text-sm">ZERO-TRUST EXECUTION GUARD</h3>
            <p className="text-[11px] font-mono text-cyan-400">IPC Socket: {socketInfo}</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="px-3 py-1 rounded-lg bg-emerald-500/20 text-emerald-300 border border-emerald-400/40 text-xs font-mono font-bold">
            ACTIVE ENFORCEMENT
          </span>
        </div>
      </div>

      {/* Approvals List */}
      <div className="space-y-3">
        {approvals.length === 0 ? (
          <div className="p-8 rounded-2xl hud-glass-panel border border-cyan-500/20 text-center text-slate-400 font-mono text-xs">
            <ShieldCheck className="w-10 h-10 text-cyan-400/60 mx-auto mb-2" />
            No pending execution requests. All systems operating safely within bounds.
          </div>
        ) : (
          approvals.map((appr) => (
            <div
              key={appr.id}
              className="p-4 rounded-2xl hud-glass-panel border border-cyan-500/40 flex flex-col sm:flex-row sm:items-center justify-between gap-4 shadow-[0_0_20px_rgba(0,229,255,0.1)]"
            >
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-cyan-400" />
                  <span className="font-bold font-hud text-slate-200 text-sm">
                    {appr.toolName || 'bash'} execution request
                  </span>
                  <span className="text-[10px] font-mono text-amber-300 bg-amber-500/20 px-2 py-0.5 rounded border border-amber-500/30">
                    PENDING APPROVAL
                  </span>
                </div>

                <div className="p-2.5 rounded-xl bg-slate-950/80 border border-cyan-500/30 font-mono text-xs text-cyan-300">
                  <code>{appr.command || JSON.stringify(appr.args)}</code>
                </div>
              </div>

              <div className="flex items-center gap-2 sm:flex-col justify-end">
                <button
                  onClick={() => handleResolve(appr.id, 'allow')}
                  className="px-4 py-2 rounded-xl bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-400 text-emerald-200 font-hud text-xs font-bold flex items-center gap-1.5 cursor-pointer transition-colors"
                >
                  <Check className="w-4 h-4" /> AUTHORIZE
                </button>
                <button
                  onClick={() => handleResolve(appr.id, 'deny')}
                  className="px-4 py-2 rounded-xl bg-red-500/20 hover:bg-red-500/30 border border-red-400 text-red-200 font-hud text-xs font-bold flex items-center gap-1.5 cursor-pointer transition-colors"
                >
                  <X className="w-4 h-4" /> DENY
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

