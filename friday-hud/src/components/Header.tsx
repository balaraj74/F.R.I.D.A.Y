import React, { useState, useEffect } from 'react';
import { Bot, BotOff, Cloud, CloudFog, CloudLightning, CloudMoon, CloudRain, CloudSnow, CloudSun, Moon, Sun, Minus, X, Pin, Volume2, VolumeX } from 'lucide-react';
import fridayLogo from '../assets/friday-logo.jpg';
import { EvolutionBadge } from './EvolutionBadge';
import { fetchWeather, versionBadge, type Weather } from '../services/weather';

function WeatherIcon({ w }: { w: Weather }) {
  const cls = 'w-6 h-6 text-cyan-300';
  switch (w.label) {
    case 'Clear': return w.isDay ? <Sun className={cls} /> : <Moon className={cls} />;
    case 'Partly cloudy': return w.isDay ? <CloudSun className={cls} /> : <CloudMoon className={cls} />;
    case 'Fog': return <CloudFog className={cls} />;
    case 'Drizzle': case 'Rain': case 'Showers': return <CloudRain className={cls} />;
    case 'Snow': case 'Snow showers': return <CloudSnow className={cls} />;
    case 'Thunderstorm': return <CloudLightning className={cls} />;
    default: return <Cloud className={cls} />;
  }
}

interface HeaderProps {
  onMinimize?: () => void;
  onClose?: () => void;
  onTogglePin?: () => void;
  isPinned?: boolean;
  currentSize?: 'compact' | 'medium' | 'full';
  onSetSize?: (size: 'compact' | 'medium' | 'full') => void;
  isVoiceMuted?: boolean;
  onToggleVoice?: () => void;
  isSpeaking?: boolean;
  onOpenEvolution?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  onMinimize,
  onClose,
  onTogglePin,
  isPinned = false,
  currentSize = 'full',
  onSetSize,
  isVoiceMuted = false,
  onToggleVoice,
  isSpeaking = false,
  onOpenEvolution,
}) => {
  const [time, setTime] = useState(new Date());
  const [weather, setWeather] = useState<Weather | null>(null);
  const [model, setModel] = useState('');
  const [autonomyPaused, setAutonomyPaused] = useState<boolean | null>(null);

  // Kill switch for FRIDAY's own activity (heartbeat loop + scheduled jobs).
  useEffect(() => {
    window.electronAPI?.getAutonomy?.().then((s) => setAutonomyPaused(s.paused)).catch(() => {});
  }, []);
  const toggleAutonomy = async () => {
    if (autonomyPaused === null || !window.electronAPI?.setAutonomy) return;
    const s = await window.electronAPI.setAutonomy(!autonomyPaused);
    setAutonomyPaused(s.paused);
  };

  // Real weather, refreshed every 15 minutes; hidden if it can't be fetched.
  useEffect(() => {
    const ctrl = new AbortController();
    const load = () => fetchWeather(ctrl.signal).then(setWeather);
    load();
    const t = setInterval(load, 15 * 60 * 1000);
    return () => { clearInterval(t); ctrl.abort(); };
  }, []);

  // FRIDAY's own version (the underlying model is confidential and never shown).
  useEffect(() => {
    window.electronAPI?.getGatewayInfo?.().then((info) => setModel(info?.version ? versionBadge(info.version) : '')).catch(() => {});
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const formattedTime = time.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });

  const formattedDate = time
    .toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
    .toUpperCase();

  return (
    <header className="relative z-30 flex items-center justify-between px-6 py-3 w-full border-b border-cyan-500/20 bg-slate-950/70 app-drag">
      {/* Brand & Monogram Logo */}
      <div className="flex items-center gap-3 app-no-drag">
        {/* Glowing Holographic Friday AI Face Avatar */}
        <div className="relative flex items-center justify-center w-11 h-11 group cursor-pointer select-none flex-shrink-0">
          {/* Outer Rotating Segmented Cyan Neon Ring */}
          <div className="absolute -inset-1 rounded-full border border-cyan-400/40 border-dashed animate-spin-slow" />
          
          {/* Ambient Plasma Glow Aura */}
          <div className="absolute -inset-0.5 rounded-full bg-cyan-400/25 blur-[6px] group-hover:bg-cyan-400/40 transition-all duration-300" />
          
          {/* Avatar Container with glowing border */}
          <div className="relative w-11 h-11 rounded-full overflow-hidden border-2 border-cyan-400/80 shadow-[0_0_14px_rgba(0,229,255,0.7)] bg-slate-950 flex items-center justify-center">
            <img
              src={fridayLogo}
              alt="FRIDAY Core"
              className="w-full h-full object-cover object-center group-hover:scale-110 transition-transform duration-300"
            />
          </div>

          {/* Micro Status Beacon Pip */}
          <span className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-emerald-400 border-2 border-slate-950 shadow-[0_0_8px_#34d399] animate-pulse" />
        </div>

        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-black tracking-widest text-cyan-400 font-hud drop-shadow-[0_0_8px_rgba(0,229,255,0.8)]">
              FRIDAY
            </h1>
            {model && (
              <span
                title="FRIDAY version"
                className="px-1.5 py-0.5 rounded bg-cyan-950/80 border border-cyan-400/50 text-[8px] font-mono font-bold text-cyan-300 shadow-[0_0_8px_rgba(0,229,255,0.3)] flex-shrink-0"
              >
                {model}
              </span>
            )}
            <EvolutionBadge currentSize={currentSize} onOpenEvolution={onOpenEvolution} />
          </div>
          <div className="text-[11px] font-semibold tracking-wider text-slate-300 font-hud">
            YOUR PERSONAL AI COMPANION
          </div>
          {currentSize !== 'compact' && (
            <div className="text-[9px] tracking-widest text-cyan-500/80 font-mono">
              THINK &nbsp;|&nbsp; PLAN &nbsp;|&nbsp; BUILD &nbsp;|&nbsp; GROW
            </div>
          )}
        </div>
      </div>

      {/* Centered Holographic Motto Quote */}
      <div className="hidden xl:flex absolute left-1/2 -translate-x-1/2 flex-col items-center justify-center pointer-events-none">
        <span className="text-xs tracking-widest text-cyan-200/90 font-hud italic drop-shadow-[0_0_6px_rgba(0,229,255,0.5)]">
          &ldquo;A MORE CAPABLE YOU, EVERY SINGLE DAY.&rdquo;
        </span>
        <span className="text-[10px] tracking-widest text-cyan-400/70 font-mono mt-0.5">
          — F.R.I.D.A.Y
        </span>
      </div>

      {/* Date, Live Bengaluru Clock, Weather & Window Controls */}
      <div className="flex items-center gap-3 md:gap-6 app-no-drag">
        {/* Clock & Location */}
        <div className="text-right">
          {currentSize !== 'compact' && (
            <div className="text-[11px] font-mono tracking-wider text-slate-400">
              {formattedDate}
            </div>
          )}
          <div className="text-lg md:text-2xl font-bold font-hud tracking-widest text-cyan-300 drop-shadow-[0_0_10px_rgba(0,229,255,0.7)] leading-none my-0.5">
            {formattedTime}
          </div>
          {currentSize !== 'compact' && (
            <div className="text-[10px] font-mono tracking-widest text-cyan-500/90">
              BENGALURU, INDIA
            </div>
          )}
        </div>

        {/* Weather Widget */}
        {currentSize !== 'compact' && weather && (
          <div
            title="Live weather, Bengaluru (Open-Meteo)"
            className="hidden sm:flex items-center gap-2.5 px-3 py-1.5 rounded-lg border border-cyan-500/25 bg-slate-900/50 backdrop-blur"
          >
            <WeatherIcon w={weather} />
            <div className="text-left">
              <div className="text-sm font-bold font-hud text-slate-100">{weather.tempC}°C</div>
              <div className="text-[10px] text-slate-400 font-mono leading-none">{weather.label}</div>
            </div>
          </div>
        )}

        {/* Size Presets & Desktop Pin Controls */}
        <div className="flex items-center gap-1.5 pl-2 border-l border-cyan-500/20">
          <div className="flex items-center gap-1 px-1.5 py-1 rounded-lg bg-slate-900/80 border border-cyan-500/30 text-[10px] font-mono">
            <button
              onClick={() => onSetSize?.('compact')}
              title="Compact Desk Widget Mode (540x640)"
              className={`px-1.5 py-0.5 rounded transition-colors ${
                currentSize === 'compact' ? 'bg-cyan-500 text-slate-950 font-bold' : 'text-slate-400 hover:text-cyan-300'
              }`}
            >
              MINI
            </button>
            <button
              onClick={() => onSetSize?.('medium')}
              title="Medium Desktop HUD (1150x740)"
              className={`px-1.5 py-0.5 rounded transition-colors ${
                currentSize === 'medium' ? 'bg-cyan-500 text-slate-950 font-bold' : 'text-slate-400 hover:text-cyan-300'
              }`}
            >
              MED
            </button>
            <button
              onClick={() => onSetSize?.('full')}
              title="Full Screen Immersion HUD (1920x1080)"
              className={`px-1.5 py-0.5 rounded transition-colors ${
                currentSize === 'full' ? 'bg-cyan-500 text-slate-950 font-bold' : 'text-slate-400 hover:text-cyan-300'
              }`}
            >
              FULL
            </button>
          </div>

          {/* Autonomy kill switch: pauses FRIDAY's own loop and scheduled jobs */}
          {autonomyPaused !== null && (
            <button
              onClick={() => void toggleAutonomy()}
              aria-pressed={!autonomyPaused}
              title={
                autonomyPaused
                  ? 'Autonomy PAUSED: FRIDAY only acts when you ask. Click to resume.'
                  : 'Autonomy active: FRIDAY works on her own every 30 min. Click to pause.'
              }
              className={`p-1.5 rounded-lg border transition-all cursor-pointer ${
                autonomyPaused
                  ? 'bg-rose-500/20 border-rose-400 text-rose-300'
                  : 'bg-emerald-500/15 border-emerald-400/60 text-emerald-300'
              }`}
            >
              {autonomyPaused ? <BotOff className="w-3.5 h-3.5" /> : <Bot className="w-3.5 h-3.5" />}
            </button>
          )}

          {/* Voice Neural Audio Mute/Unmute Toggle */}
          <button
            onClick={onToggleVoice}
            title={isVoiceMuted ? 'Unmute Neural Irish Voice' : 'Mute Neural Voice'}
            className={`p-1.5 rounded-lg border transition-all cursor-pointer ${
              !isVoiceMuted
                ? 'bg-cyan-500/25 border-cyan-400 text-cyan-300 shadow-[0_0_10px_#00e5ff]'
                : 'border-slate-800 text-slate-500 hover:border-cyan-500/40 hover:text-cyan-300'
            }`}
          >
            {isVoiceMuted ? (
              <VolumeX className="w-3.5 h-3.5" />
            ) : (
              <div className="relative">
                <Volume2 className="w-3.5 h-3.5" />
                {isSpeaking && (
                  <span className="absolute -top-1 -right-1 w-1.5 h-1.5 rounded-full bg-cyan-300 animate-ping" />
                )}
              </div>
            )}
          </button>

          <button
            onClick={onTogglePin}
            title={isPinned ? "Unpin (Restore Floating)" : "Pin to Home Screen Wallpaper"}
            className={`p-1.5 rounded-lg border transition-all ${
              isPinned
                ? 'bg-cyan-500/25 border-cyan-400 text-cyan-300 shadow-[0_0_10px_#00e5ff]'
                : 'border-slate-800 text-slate-400 hover:border-cyan-500/40 hover:text-cyan-300'
            }`}
          >
            <Pin className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onMinimize}
            title="Minimize Widget"
            className="p-1.5 rounded-lg text-slate-400 hover:text-cyan-300 hover:bg-cyan-500/20 transition-colors"
          >
            <Minus className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onClose}
            title="Close HUD"
            className="p-1.5 rounded-lg text-slate-400 hover:text-red-400 hover:bg-red-500/20 transition-colors"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </header>
  );
};

