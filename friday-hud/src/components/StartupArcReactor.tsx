import React, { useState, useEffect } from 'react';
import { Power, Terminal, Cpu, ShieldAlert, Sparkles, CheckCircle2 } from 'lucide-react';
import { gateway } from '../services/gateway-ws';
import { speechService } from '../services/speech';

interface StartupArcReactorProps {
  onStarted: () => void;
  /** Tells the app a start-up is in progress, so it keeps this screen until the sequence ends. */
  onBootingChange?: (booting: boolean) => void;
}

export const StartupArcReactor: React.FC<StartupArcReactorProps> = ({ onStarted, onBootingChange }) => {
  const [booting, setBooting] = useState(false);
  useEffect(() => onBootingChange?.(booting), [booting, onBootingChange]);
  const [progress, setProgress] = useState(0);
  const [bootLogs, setBootLogs] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Synthesize sci-fi power-up sound using Web Audio API
  const playPowerUpSound = () => {
    try {
      const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContext) return;
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sawtooth';
      // Low rumble rising to high pitch sci-fi hum
      osc.frequency.setValueAtTime(60, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 3.2);

      gain.gain.setValueAtTime(0.01, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.12, ctx.currentTime + 1.5);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 3.4);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 3.5);
    } catch (e) {
      // Audio context might be restricted before user gesture
    }
  };

  // Real start-up: each log line reports a step that actually happened, nothing is staged.
  // Order: reasoning engine -> gateway -> voice models (loading in parallel since the start)
  // -> HUD connection -> tools. Each service is started only if it isn't already running.
  const handleStartFriday = async () => {
    if (booting) return;
    setBooting(true);
    setErrorMsg(null);
    setProgress(5);
    setBootLogs(['[START] Initialising FRIDAY...']);
    playPowerUpSound();

    const addLog = (log: string, pct?: number) => {
      if (pct !== undefined) setProgress(pct);
      setBootLogs((prev) => [...prev, log]);
    };
    const secs = (ms?: number) => (ms ? ` (${(ms / 1000).toFixed(1)} s)` : '');
    const fail = (msg: string) => {
      setErrorMsg(msg);
      setBooting(false);
    };

    try {
      const boot = window.electronAPI?.bootStep;
      // Voice models take ~25 s to load: start them now, collect the result later.
      const voice = boot ? boot('voice') : null;
      if (boot) addLog('[VOICE] Loading speech models in the background...', 8);

      if (boot) {
        addLog('[BRAIN] Starting reasoning engine...', 12);
        const brain = await boot('brain');
        if (!brain.ok) return fail(brain.error || 'The reasoning engine did not start.');
        addLog(brain.already ? '[BRAIN] Already running' : `[BRAIN] Online${secs(brain.ms)}`, 35);

        addLog('[GATEWAY] Starting gateway...', 40);
        const gw = await boot('gateway');
        if (!gw.ok) return fail(gw.error || 'The gateway did not start.');
        addLog(gw.already ? '[GATEWAY] Already running' : `[GATEWAY] Online${secs(gw.ms)}`, 55);
      } else if (window.electronAPI?.startGateway) {
        const res = await window.electronAPI.startGateway();
        if (!res.success && !res.running) return fail(res.error || 'Gateway took too long to respond.');
        addLog(res.running ? '[GATEWAY] Already running' : '[GATEWAY] Started', 55);
      } else {
        addLog('[HUD] Not running inside the desktop app; connecting to an existing gateway', 55);
      }

      if (voice) {
        addLog('[VOICE] Waiting for speech models...', 60);
        const v = await voice;
        const parts = [
          v.installed?.stt ? `hearing ${v.stt ? 'ready' : 'not ready'}` : 'hearing: cloud',
          v.installed?.tts ? `voice ${v.tts ? 'ready' : 'not ready'}` : 'voice: cloud',
          v.installed?.tts ? `speech detection ${v.vad ? 'ready' : 'not ready'}` : null,
        ].filter(Boolean);
        addLog(`[VOICE] ${parts.join(', ')}${secs(v.ms)}`, 75);
        void speechService.prepareFillers();
      }

      addLog('[HUD] Connecting to gateway...', 80);
      gateway.connect();
      const connected = await new Promise<boolean>((resolve) => {
        if (gateway.connected) return resolve(true);
        const timer = setTimeout(() => {
          unsub();
          resolve(false);
        }, 15000);
        const unsub = gateway.onStatus((ok) => {
          if (!ok) return;
          clearTimeout(timer);
          unsub();
          resolve(true);
        });
      });
      if (!connected) return fail('Gateway is up but the HUD could not connect (check the gateway token). Retry or check tmux.');
      addLog('[HUD] Connected', 88);

      try {
        const res = await gateway.request<{ servers?: Array<{ name: string; state: string; tools: string[] }> }>('mcp.status', {});
        const servers = res?.servers ?? [];
        addLog(
          servers.length
            ? `[TOOLS] ${servers.map((m) => `${m.name}: ${m.state === 'connected' ? `${m.tools.length} tools` : m.state}`).join(', ')}`
            : '[TOOLS] Built-in tools ready',
          95,
        );
      } catch {
        addLog('[TOOLS] Built-in tools ready (external tools status unavailable)', 95);
      }

      addLog('[READY] FRIDAY is online.', 100);
      setTimeout(() => {
        setBooting(false);
        onStarted();
      }, 600);
    } catch (err: any) {
      console.warn('FRIDAY start-up failed:', err);
      fail(err?.message || 'Failed to start FRIDAY.');
    }
  };

  return (
    <div className="relative w-full h-full flex flex-col items-center justify-center p-6 text-slate-100 overflow-hidden select-none">
      {/* Background cyber grid & energy rings */}
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(0,229,255,0.08)_0,transparent_70%)] pointer-events-none" />

      {/* Holographic Arc Reactor Visual */}
      <div className="relative flex items-center justify-center w-72 h-72 mb-6">
        {/* Outer Pulsing Ring */}
        <div
          className={`absolute inset-0 rounded-full border-2 transition-all duration-700 ${
            booting
              ? 'border-cyan-400 animate-spin border-dashed shadow-[0_0_50px_rgba(0,229,255,0.6)]'
              : 'border-cyan-500/30 shadow-[0_0_30px_rgba(0,229,255,0.2)]'
          }`}
          style={{ animationDuration: booting ? '4s' : '18s' }}
        />

        {/* Middle Segmented Ring */}
        <div
          className={`absolute inset-6 rounded-full border border-cyan-400/40 border-t-transparent border-b-transparent transition-all ${
            booting ? 'animate-spin' : ''
          }`}
          style={{ animationDuration: '3s', animationDirection: 'reverse' }}
        />

        {/* Counter-rotating Inner Tech Ring */}
        <div
          className="absolute inset-12 rounded-full border-2 border-dashed border-cyan-300/30 animate-spin"
          style={{ animationDuration: '8s' }}
        />

        {/* Inner Glowing Reactor Core */}
        <div
          className={`relative z-10 w-36 h-36 rounded-full flex flex-col items-center justify-center transition-all duration-500 ${
            booting
              ? 'bg-cyan-500/20 shadow-[0_0_60px_#00e5ff] scale-105 border-2 border-cyan-300'
              : 'bg-slate-900/80 shadow-[0_0_30px_rgba(0,229,255,0.3)] border border-cyan-500/50 hover:scale-105'
          }`}
        >
          {booting ? (
            <div className="flex flex-col items-center justify-center">
              <Sparkles className="w-10 h-10 text-cyan-300 animate-spin" style={{ animationDuration: '2s' }} />
              <span className="text-[11px] font-hud font-bold text-cyan-200 mt-2 tracking-widest">
                {progress}%
              </span>
            </div>
          ) : (
            <button
              onClick={handleStartFriday}
              className="flex flex-col items-center justify-center group cursor-pointer w-full h-full"
            >
              <Power className="w-12 h-12 text-cyan-400 group-hover:text-white transition-transform group-hover:scale-110 drop-shadow-[0_0_15px_#00e5ff]" />
              <span className="text-[10px] font-hud font-bold text-cyan-300/90 tracking-widest mt-1 group-hover:text-cyan-100">
                POWER ON
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Title & Status */}
      <div className="text-center max-w-md z-10">
        <h2 className="text-2xl font-black font-hud tracking-widest text-transparent bg-clip-text bg-gradient-to-r from-cyan-300 via-white to-cyan-400 drop-shadow-[0_0_15px_rgba(0,229,255,0.7)]">
          {booting ? 'NEURAL MATRIX INITIALIZING...' : 'F.R.I.D.A.Y CORE STANDBY'}
        </h2>
        <p className="text-xs font-mono text-cyan-400/80 mt-1 tracking-wider">
          {booting
            ? 'STARTING REASONING ENGINE, GATEWAY, VOICE AND TOOLS'
            : 'OFFLINE: PRESS INITIALIZE TO START EVERYTHING'}
        </p>
      </div>

      {/* Main Action Button */}
      {!booting && (
        <div className="mt-6 flex flex-col items-center gap-3 z-10">
          <button
            onClick={handleStartFriday}
            className="group relative px-8 py-3.5 rounded-xl font-hud font-bold tracking-widest text-sm text-slate-950 bg-gradient-to-r from-cyan-400 to-cyan-300 hover:from-cyan-300 hover:to-white shadow-[0_0_35px_rgba(0,229,255,0.6)] transition-all duration-300 hover:scale-105 active:scale-95 cursor-pointer flex items-center gap-3"
          >
            <Power className="w-4 h-4 text-slate-950 group-hover:rotate-90 transition-transform duration-300" />
            INITIALIZE F.R.I.D.A.Y
          </button>

          <button
            onClick={onStarted}
            className="text-[11px] font-mono text-slate-400 hover:text-cyan-300 transition-colors underline underline-offset-4 cursor-pointer"
          >
            Already running? Enter live HUD directly &rarr;
          </button>
        </div>
      )}

      {/* Boot Terminal Diagnostic Stream */}
      {booting && (
        <div className="w-full max-w-lg mt-6 p-3.5 rounded-xl hud-glass-panel border border-cyan-500/30 font-mono text-[11px] text-cyan-300/90 z-10 shadow-[0_0_30px_rgba(0,0,0,0.6)]">
          <div className="flex items-center justify-between pb-2 mb-2 border-b border-cyan-500/20 text-[10px] text-slate-400">
            <span className="flex items-center gap-1.5 font-hud text-cyan-300">
              <Terminal className="w-3.5 h-3.5" /> BOOT DIAGNOSTICS
            </span>
            <span>STAGE: {progress}%</span>
          </div>

          <div className="space-y-1 max-h-32 overflow-y-auto">
            {bootLogs.map((log, idx) => (
              <div key={idx} className="flex items-start gap-2 leading-relaxed">
                <span className="text-cyan-500 font-bold">&gt;</span>
                <span>{log}</span>
              </div>
            ))}
          </div>

          {/* Progress Bar */}
          <div className="w-full h-1.5 bg-slate-900 rounded-full mt-3 overflow-hidden border border-cyan-500/30">
            <div
              className="h-full bg-gradient-to-r from-cyan-500 to-cyan-300 transition-all duration-300 shadow-[0_0_10px_#00e5ff]"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {/* Error Banner if any */}
      {errorMsg && (
        <div className="mt-4 p-3 rounded-xl bg-red-950/60 border border-red-500/50 text-red-300 text-xs font-mono flex items-center gap-2 max-w-md z-10">
          <ShieldAlert className="w-4 h-4 flex-shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}
    </div>
  );
};

