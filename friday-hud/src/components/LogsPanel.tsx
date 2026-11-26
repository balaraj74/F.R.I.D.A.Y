import React, { useState, useEffect, useRef } from 'react';
import { Terminal, RefreshCw, Filter, Trash2, ArrowDown, Download } from 'lucide-react';
import { gateway } from '../services/gateway-ws';
import { parseLogLine, type LogLevel } from '../services/log-format';

export const LogsPanel: React.FC = () => {
  const [logs, setLogs] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);
  const [logFile, setLogFile] = useState<string>('');
  const [levels, setLevels] = useState<Record<string, boolean>>({ ERROR: true, WARN: true, INFO: true, DEBUG: false });
  const [expanded, setExpanded] = useState<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const loadLogs = async () => {
    setLoading(true);
    try {
      const data = await gateway.getLogs(150);
      setLogs(data.lines);
      if (data.file) setLogFile(data.file);
    } catch (e) {
      console.warn('Failed to load logs:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLogs();
    const interval = setInterval(loadLogs, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, autoScroll]);

  const parsed = logs.map(parseLogLine);
  const q = filter.trim().toLowerCase();
  const filteredLogs = parsed.filter(
    (l) => (levels[l.level] ?? true) && (!q || l.raw.toLowerCase().includes(q)),
  );
  const counts = parsed.reduce<Record<string, number>>((acc, l) => ((acc[l.level] = (acc[l.level] ?? 0) + 1), acc), {});
  const levelClass: Record<LogLevel, string> = {
    ERROR: 'text-red-400',
    WARN: 'text-amber-300',
    INFO: 'text-cyan-200',
    DEBUG: 'text-slate-400',
    TRACE: 'text-slate-500',
    OTHER: 'text-slate-300',
  };


  return (
    <div className="flex-1 flex flex-col p-4 overflow-hidden space-y-3">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-2 border-b border-cyan-500/20 gap-2">
        <div>
          <h2 className="text-lg font-bold font-hud tracking-wider text-cyan-300 flex items-center gap-2">
            <Terminal className="w-5 h-5 text-cyan-400 animate-pulse" />
            LIVE GATEWAY TELEMETRY & SYSTEM LOGS
          </h2>
          <p className="text-xs font-mono text-slate-400 truncate max-w-lg" title={logFile}>
            Log stream source: {logFile || '/tmp/friday/friday.log'}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setAutoScroll(!autoScroll)}
            className={`px-2.5 py-1.5 rounded-xl border text-xs font-mono flex items-center gap-1 cursor-pointer transition-colors ${
              autoScroll
                ? 'bg-cyan-500/20 border-cyan-400 text-cyan-300'
                : 'border-slate-800 text-slate-400 hover:text-slate-200'
            }`}
          >
            <ArrowDown className="w-3.5 h-3.5" /> Auto-Scroll
          </button>

          <button
            onClick={() => setLogs([])}
            className="p-1.5 rounded-xl border border-slate-800 hover:border-red-500/40 text-slate-400 hover:text-red-300 transition-colors"
            title="Clear view"
          >
            <Trash2 className="w-4 h-4" />
          </button>

          <button
            onClick={loadLogs}
            disabled={loading}
            className="px-3 py-1.5 rounded-xl border border-cyan-500/40 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 text-xs font-mono flex items-center gap-1.5 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            REFRESH
          </button>
        </div>
      </div>

      {/* Filter Input */}
      <div className="flex items-center gap-2">
        <Filter className="w-4 h-4 text-cyan-400" />
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter log output (e.g. error, whatsapp, chat, skills)..."
          className="flex-1 px-3 py-1.5 rounded-xl hud-glass-panel border border-cyan-500/30 text-xs font-mono text-cyan-100 placeholder-slate-500 focus:outline-none focus:border-cyan-400"
        />
        <div className="flex items-center gap-1">
          {(['ERROR', 'WARN', 'INFO', 'DEBUG'] as const).map((lv) => (
            <button
              key={lv}
              type="button"
              aria-pressed={levels[lv]}
              onClick={() => setLevels((p) => ({ ...p, [lv]: !p[lv] }))}
              className={`px-2 py-1 rounded-lg border text-[10px] font-mono transition-colors ${
                levels[lv] ? `border-cyan-500/40 bg-cyan-500/10 ${levelClass[lv]}` : 'border-slate-700 text-slate-500'
              }`}
            >
              {lv} {counts[lv] ?? 0}
            </button>
          ))}
        </div>
        <span className="text-[11px] font-mono text-slate-400 whitespace-nowrap">
          {filteredLogs.length} lines
        </span>
      </div>

      {/* Terminal View */}
      <div className="flex-1 overflow-y-auto p-3.5 rounded-xl bg-slate-950/80 border border-cyan-500/30 font-mono text-[11px] space-y-1 select-text shadow-[inset_0_0_20px_rgba(0,0,0,0.8)]">
        {filteredLogs.length === 0 && (
          <div className="text-slate-500">{logs.length ? 'No lines match the current filters.' : 'No log lines yet.'}</div>
        )}
        {filteredLogs.map((l, idx) => (
          <div key={idx} className="leading-relaxed">
            <button
              type="button"
              onClick={() => setExpanded(expanded === idx ? null : idx)}
              className="w-full text-left flex items-start gap-2 hover:bg-cyan-500/5 rounded px-1"
              title={l.details ? 'Show details' : undefined}
            >
              <span className="text-slate-500 select-none tabular-nums shrink-0">{l.time || '--:--:--'}</span>
              <span className={`shrink-0 w-11 font-bold ${levelClass[l.level]}`}>{l.level === 'OTHER' ? '' : l.level}</span>
              {l.subsystem && <span className="shrink-0 text-cyan-500/80">[{l.subsystem}]</span>}
              <span className={`break-words min-w-0 ${levelClass[l.level]}`}>{l.message}</span>
            </button>
            {expanded === idx && l.details !== undefined && (
              <pre className="ml-24 mt-1 mb-2 p-2 rounded-lg bg-slate-900/80 text-[10px] text-slate-300 whitespace-pre-wrap break-all">
                {JSON.stringify(l.details, null, 2)}
              </pre>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
};

