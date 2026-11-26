import React, { useState, useEffect } from 'react';
import { Settings, Cpu, HardDrive, Shield, RefreshCw, Power, ExternalLink, CheckCircle } from 'lucide-react';
import { gateway } from '../services/gateway-ws';
import { fridayLabel, useFridayInfo } from '../services/friday-info';
import { GatewayStatusPayload } from '../types';

export const ConfigSettingsPanel: React.FC = () => {
  const [status, setStatus] = useState<GatewayStatusPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const loadStatus = async () => {
    setLoading(true);
    try {
      const data = await gateway.getStatus();
      setStatus(data);
    } catch (e) {
      console.warn('Failed to load status:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStatus();
  }, []);

  const handleRestart = async () => {
    setRestarting(true);
    try {
      if (window.electronAPI?.stopGateway) {
        await window.electronAPI.stopGateway();
      }
      setTimeout(async () => {
        if (window.electronAPI?.startGateway) {
          await window.electronAPI.startGateway();
        }
        setTimeout(() => {
          setRestarting(false);
          loadStatus();
        }, 3000);
      }, 1000);
    } catch (e) {
      console.warn('Restart failed:', e);
      setRestarting(false);
    }
  };

  const handleStop = async () => {
    if (window.electronAPI?.stopGateway) {
      await window.electronAPI.stopGateway();
    }
  };

  const fridayInfo = useFridayInfo();
  // Only real numbers from the gateway; unknown values render as "—".
  const activeSession = status?.sessions?.recent?.[0];
  const totalTokens = activeSession?.totalTokens;
  const contextTokens = activeSession?.contextTokens || status?.sessions?.defaults?.contextTokens;
  const pctUsed =
    totalTokens != null && contextTokens ? Math.min(100, Math.round((totalTokens / contextTokens) * 100)) : null;
  const connected = gateway.connected;

  return (
    <div className="flex-1 flex flex-col p-4 overflow-y-auto space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between pb-3 border-b border-cyan-500/20">
        <div>
          <h2 className="text-lg font-bold font-hud tracking-wider text-cyan-300 flex items-center gap-2">
            <Settings className="w-5 h-5 text-cyan-400 animate-pulse" />
            SETTINGS
          </h2>
          <p className="text-xs font-mono text-slate-400">
            Engine, gateway connection and process lifecycle
          </p>
        </div>

        <button
          onClick={loadStatus}
          disabled={loading}
          className="px-3 py-1.5 rounded-xl border border-cyan-500/40 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 text-xs font-mono flex items-center gap-1.5 cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          REFRESH
        </button>
      </div>

      {/* Grid Settings Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Model Card */}
        <div className="p-4 rounded-2xl hud-glass-panel border border-cyan-500/30 space-y-3">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-cyan-500/20 text-cyan-300 border border-cyan-400/30">
              <Cpu className="w-6 h-6" />
            </div>
            <div>
              <h3 className="font-bold font-hud text-slate-100 text-sm">FRIDAY ENGINE</h3>
              <p className="text-[11px] font-mono text-cyan-400">{fridayLabel(fridayInfo)} · ARIA</p>
            </div>
          </div>

          <div className="space-y-2 font-mono text-xs text-slate-300 pt-2 border-t border-cyan-500/15">
            <div className="flex justify-between">
              <span className="text-slate-400">Version:</span>
              <span className="text-cyan-200 font-bold">{fridayInfo.version || '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Context Window:</span>
              <span>{contextTokens ? `${contextTokens.toLocaleString()} tokens` : '—'}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Current Session Context:</span>
              <span className="text-emerald-300 font-bold">
                {totalTokens != null ? `${totalTokens.toLocaleString()}${pctUsed != null ? ` (${pctUsed}%)` : ''}` : '—'}
              </span>
            </div>

            {/* Token usage bar (only when the gateway reports real numbers) */}
            {pctUsed != null && (
              <div className="w-full h-1.5 bg-slate-900 rounded-full mt-2 overflow-hidden border border-cyan-500/30">
                <div className="h-full bg-gradient-to-r from-cyan-500 to-emerald-400" style={{ width: `${pctUsed}%` }} />
              </div>
            )}
          </div>
        </div>

        {/* Gateway Daemon Info */}
        <div className="p-4 rounded-2xl hud-glass-panel border border-cyan-500/30 space-y-3">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-cyan-500/20 text-cyan-300 border border-cyan-400/30">
              <Shield className="w-6 h-6" />
            </div>
            <div>
              <h3 className="font-bold font-hud text-slate-100 text-sm">GATEWAY DAEMON</h3>
              <p className="text-[11px] font-mono text-cyan-400">{gateway.endpoint}</p>
            </div>
          </div>

          <div className="space-y-2 font-mono text-xs text-slate-300 pt-2 border-t border-cyan-500/15">
            <div className="flex justify-between">
              <span className="text-slate-400">Bind Mode:</span>
              <span className="text-cyan-200 font-bold">
                {/^wss?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(gateway.endpoint) ? 'loopback (this machine only)' : 'network'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Operator Auth:</span>
              {connected ? (
                <span className="text-emerald-300 flex items-center gap-1 font-bold">
                  <CheckCircle className="w-3.5 h-3.5" /> Connected
                </span>
              ) : (
                <span className="text-amber-300 font-bold">Not connected</span>
              )}
            </div>
            <div className="flex justify-between">
              <span className="text-slate-400">Workspace Dir:</span>
              <span className="text-slate-300 text-[11px]">
                {fridayInfo.workspaceDir ? fridayInfo.workspaceDir.replace(/^\/home\/[^/]+/, '~') : '—'}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Lifecycle Actions */}
      <div className="p-4 rounded-2xl hud-glass-panel border border-cyan-500/30">
        <h3 className="text-xs font-bold font-hud tracking-wider text-cyan-300 mb-3">
          DAEMON LIFECYCLE CONTROLS
        </h3>

        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={handleRestart}
            disabled={restarting}
            className="px-4 py-2 rounded-xl bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/50 text-cyan-200 font-hud text-xs font-bold flex items-center gap-2 cursor-pointer transition-colors active:scale-95"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${restarting ? 'animate-spin' : ''}`} />
            {restarting ? 'RESTARTING DAEMON...' : 'RESTART FRIDAY GATEWAY'}
          </button>

          <button
            onClick={handleStop}
            className="px-4 py-2 rounded-xl bg-red-500/20 hover:bg-red-500/30 border border-red-500/40 text-red-300 font-hud text-xs font-bold flex items-center gap-2 cursor-pointer transition-colors"
          >
            <Power className="w-3.5 h-3.5" /> STOP GATEWAY
          </button>

          <a
            href={gateway.endpoint.replace(/^ws/, 'http')}
            target="_blank"
            rel="noreferrer"
            className="px-4 py-2 rounded-xl border border-slate-700 hover:border-cyan-500/40 text-slate-300 hover:text-cyan-300 font-hud text-xs flex items-center gap-2 transition-colors"
          >
            <ExternalLink className="w-3.5 h-3.5" /> OPEN WEB CONTROL UI
          </a>
        </div>
      </div>
    </div>
  );
};

