import React, { useState, useEffect } from 'react';
import { MessageSquare, PhoneCall, RefreshCw, CheckCircle, XCircle, AlertCircle, ShieldCheck, Radio } from 'lucide-react';
import { gateway } from '../services/gateway-ws';
import { ChannelsStatus } from '../types';

export const ChannelsPanel: React.FC = () => {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<ChannelsStatus | null>(null);
  const [summary, setSummary] = useState<string[]>([]);

  const loadChannels = async (probe = false) => {
    setLoading(true);
    try {
      const data = await gateway.getChannels(probe);
      setStatus(data);
      const gwStatus = await gateway.getStatus();
      if (gwStatus?.channelSummary) {
        setSummary(gwStatus.channelSummary);
      }
    } catch (e) {
      console.warn('Failed to load channels:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadChannels(false);
    const interval = setInterval(() => loadChannels(false), 8000);
    return () => clearInterval(interval);
  }, []);

  const wa = status?.channels?.whatsapp;
  // Real WhatsApp state from the gateway; never assume "online".
  const waState = !status
    ? { label: 'CHECKING…', tone: 'slate' as const }
    : wa?.connected
      ? { label: 'CONNECTED', tone: 'emerald' as const }
      : wa?.linked
        ? { label: 'LINKED · OFFLINE', tone: 'amber' as const }
        : { label: 'NOT LINKED', tone: 'rose' as const };
  const toneClass = {
    emerald: 'bg-emerald-500/20 border-emerald-500/30 text-emerald-300',
    amber: 'bg-amber-500/20 border-amber-500/30 text-amber-300',
    rose: 'bg-rose-500/20 border-rose-500/30 text-rose-300',
    slate: 'bg-slate-500/20 border-slate-500/30 text-slate-300',
  }[waState.tone];
  const ago = (ms?: number | null) => {
    if (ms == null) return '—';
    const m = Math.round(ms / 60000);
    return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
  };
  const discord = status?.channels?.discord;
  const gchat = status?.channels?.googlechat;

  return (
    <div className="flex-1 flex flex-col p-4 overflow-y-auto space-y-4">
      {/* Header Bar */}
      <div className="flex items-center justify-between pb-3 border-b border-cyan-500/20">
        <div>
          <h2 className="text-lg font-bold font-hud tracking-wider text-cyan-300 flex items-center gap-2">
            <Radio className="w-5 h-5 text-cyan-400 animate-pulse" />
            COMMUNICATION CHANNELS & MESSAGING
          </h2>
          <p className="text-xs font-mono text-slate-400">
            Real-time bridges connecting F.R.I.D.A.Y to WhatsApp, Discord & External Agents
          </p>
        </div>

        <button
          onClick={() => loadChannels(true)}
          disabled={loading}
          className="px-3 py-1.5 rounded-xl border border-cyan-500/40 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 text-xs font-mono flex items-center gap-2 cursor-pointer transition-all active:scale-95"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-cyan-200' : ''}`} />
          {loading ? 'PROBING...' : 'PROBE GATEWAYS'}
        </button>
      </div>

      {/* Main Channel Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* WhatsApp Card (Primary) */}
        <div className="p-4 rounded-2xl hud-glass-panel border border-cyan-400/50 relative overflow-hidden group shadow-[0_0_25px_rgba(0,229,255,0.15)]">
          <div className={`absolute top-0 right-0 px-3 py-1 border-b border-l text-[10px] font-hud font-bold tracking-widest rounded-bl-xl flex items-center gap-1.5 ${toneClass}`}>
            <span className={`w-2 h-2 rounded-full bg-current ${waState.tone === 'emerald' ? 'animate-pulse' : ''}`} />
            {waState.label}
          </div>

          <div className="flex items-center gap-3 mb-3">
            <div className="p-2.5 rounded-xl bg-emerald-500/20 border border-emerald-400/40 text-emerald-300">
              <PhoneCall className="w-6 h-6" />
            </div>
            <div>
              <h3 className="font-bold font-hud text-slate-100 text-base">WhatsApp</h3>
              <p className="text-[11px] font-mono text-emerald-400">Primary Mobile Uplink</p>
            </div>
          </div>

          <div className="space-y-2 font-mono text-xs text-slate-300 pt-2 border-t border-cyan-500/20">
            <div className="flex justify-between items-center">
              <span className="text-slate-400 text-[11px]">Assigned Number:</span>
              <span className="font-bold text-cyan-200 bg-cyan-950/60 px-2 py-0.5 rounded border border-cyan-500/30">
                {wa?.self?.e164 || '—'}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-400 text-[11px]">JID Identity:</span>
              <span className="text-[10px] text-slate-300 truncate max-w-[170px]" title={wa?.self?.jid}>
                {wa?.self?.jid || '—'}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-400 text-[11px]">DM Security Policy:</span>
              <span className="text-emerald-400 flex items-center gap-1 text-[11px]">
                <ShieldCheck className="w-3.5 h-3.5" /> {wa?.dmPolicy === 'allowlist' ? 'Allowlist only' : wa?.dmPolicy || '—'}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-400 text-[11px]">Authorized User:</span>
              <span className="text-cyan-300 font-bold">{wa?.allowFrom?.length ? wa.allowFrom.join(', ') : '—'}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-400 text-[11px]">Last connected:</span>
              <span className={wa?.connected ? 'text-emerald-300 font-bold' : 'text-slate-300'}>
                {wa?.connected ? 'now' : ago(wa?.lastConnectedAt ? Date.now() - wa.lastConnectedAt : null)}
              </span>
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-cyan-500/20 flex gap-2">
            <button
              onClick={() => loadChannels(true)}
              className="flex-1 py-1.5 px-2 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-400/40 text-emerald-200 font-hud text-[10px] tracking-wider transition-colors cursor-pointer"
            >
              TEST PING
            </button>
            <span className="text-[10px] font-mono text-slate-400 flex items-center px-2">
              Authed 1m ago
            </span>
          </div>
        </div>

        {/* Discord Card */}
        <div className="p-4 rounded-2xl hud-glass-panel border border-cyan-500/20 relative overflow-hidden">
          <div className="absolute top-0 right-0 px-3 py-1 bg-amber-500/20 border-b border-l border-amber-500/30 text-amber-300 text-[10px] font-hud font-bold tracking-widest rounded-bl-xl flex items-center gap-1">
            <AlertCircle className="w-3 h-3 text-amber-400" />
            STANDBY
          </div>

          <div className="flex items-center gap-3 mb-3">
            <div className="p-2.5 rounded-xl bg-indigo-500/20 border border-indigo-400/40 text-indigo-300">
              <MessageSquare className="w-6 h-6" />
            </div>
            <div>
              <h3 className="font-bold font-hud text-slate-100 text-base">Discord Bot</h3>
              <p className="text-[11px] font-mono text-slate-400">Server & Community Bridge</p>
            </div>
          </div>

          <div className="space-y-2 font-mono text-xs text-slate-300 pt-2 border-t border-cyan-500/20">
            <div className="flex justify-between items-center">
              <span className="text-slate-400 text-[11px]">Configuration:</span>
              <span className="text-cyan-300 font-bold">Config Token Present</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-400 text-[11px]">Current State:</span>
              <span className="text-amber-400 font-bold">Disabled (Standby)</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-400 text-[11px]">Account ID:</span>
              <span className="text-slate-300">default</span>
            </div>
          </div>

          <div className="mt-8 pt-3 border-t border-cyan-500/20 text-[11px] font-mono text-slate-400 text-center">
            Managed via ~/.friday/friday.json
          </div>
        </div>

        {/* Google Chat Card */}
        <div className="p-4 rounded-2xl hud-glass-panel border border-cyan-500/20 relative overflow-hidden">
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2.5 rounded-xl bg-slate-800/60 border border-slate-700 text-slate-400">
              <MessageSquare className="w-6 h-6" />
            </div>
            <div>
              <h3 className="font-bold font-hud text-slate-200 text-base">Google Chat</h3>
              <p className="text-[11px] font-mono text-slate-400">Workspace Webhook</p>
            </div>
          </div>

          <div className="space-y-2 font-mono text-xs text-slate-400 pt-2 border-t border-cyan-500/20">
            <div className="flex justify-between items-center">
              <span className="text-[11px]">Configuration:</span>
              <span className="text-slate-400">Not Configured</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-[11px]">Audience:</span>
              <span className="text-slate-400">None</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-[11px]">Status:</span>
              <span className="text-slate-400">Inactive</span>
            </div>
          </div>

          <div className="mt-8 pt-3 border-t border-cyan-500/20 text-[11px] font-mono text-slate-400 text-center">
            Optional Enterprise Integration
          </div>
        </div>
      </div>

      {/* Gateway Channel Summary Log */}
      <div className="p-4 rounded-2xl hud-glass-panel border border-cyan-500/30">
        <h3 className="text-xs font-bold font-hud tracking-wider text-cyan-300 mb-2 flex items-center gap-2">
          <CheckCircle className="w-4 h-4 text-cyan-400" />
          ACTIVE GATEWAY SESSIONS & ROUTING SUMMARY
        </h3>
        <div className="space-y-1.5 font-mono text-xs text-slate-300">
          {summary.length > 0 ? (
            summary.map((line, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <span className="text-cyan-400 font-bold">&gt;</span>
                <span className={line.includes('linked') ? 'text-emerald-300' : 'text-slate-300'}>
                  {line}
                </span>
              </div>
            ))
          ) : (
            <div className="text-slate-400">{status ? 'No active sessions reported by the gateway.' : 'Loading…'}</div>
          )}
        </div>
      </div>
    </div>
  );
};

