import React, { useEffect, useRef, useState } from 'react';
import { ReactorCanvas } from './ReactorCanvas';
import { startFrameLoop } from '../services/frame-loop';
import { moodWords, presence, type Affect, type PresenceMode, type PresenceSnapshot } from '../services/presence';

interface ArcReactorCoreProps {
  statusText?: string;
  // Kept for API compatibility; the live state now comes from the presence store.
  isListening?: boolean;
  isThinking?: boolean;
  isSpeaking?: boolean;
  onSelectTag?: (tag: string) => void;
  onToggleMic?: () => void;
  /** 'top': name + status float as a capsule centred at the top of the window (full HUD). */
  headerPlacement?: 'inline' | 'top';
}

// Accent per mode for the DOM chrome around the shader (text, equaliser, pedestal).
const ACCENT: Record<PresenceMode, string> = {
  idle: '#00E5FF',
  listening: '#5CF2FF',
  thinking: '#FF4D2E',
  acting: '#FFB547',
  speaking: '#E6FBFF',
  approval: '#FF9E3D',
};

function statusLabel(s: PresenceSnapshot, idleText: string): string {
  switch (s.mode) {
    case 'listening': return 'LISTENING';
    case 'thinking': return 'THINKING';
    case 'acting': return s.activeTool ? `RUNNING ${s.activeTool.toUpperCase()}` : 'WORKING';
    case 'speaking': return 'SPEAKING';
    case 'approval': return 'AWAITING YOUR APPROVAL';
    default: return idleText.split('//')[0].trim();
  }
}

const leftTags = [
  { label: 'UNDERSTAND', desc: 'Context & semantic intent parser' },
  { label: 'PLAN', desc: 'Multi-agent goal decomposition' },
  { label: 'EXECUTE', desc: 'Parallel tool execution engine' },
  { label: 'LEARN', desc: 'Epistemic memory distillation' },
  { label: 'EVOLVE', desc: 'Recursive agent self-improvement' },
];

const rightTags = [
  { label: 'IDEAS', desc: 'Autonomous hypothesis generation' },
  { label: 'PROJECTS', desc: 'Active repositories & build status' },
  { label: 'KNOWLEDGE', desc: 'RAG index & neural graph vectors' },
  { label: 'HEALTH', desc: 'Hardware thermals & system stats' },
  { label: 'CAREER', desc: 'Portfolio, OSS & professional uplink' },
  { label: 'LIFE', desc: 'Personal calendar & daily briefings' },
];

const BAR_SHAPE = [0.45, 0.8, 0.6, 1, 0.7, 0.5, 0.9, 0.6];

// Short synthesized chirp on overdrive click.
function playCorePulseAudio() {
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(140, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(540, ctx.currentTime + 0.12);
    osc.frequency.exponentialRampToValueAtTime(90, ctx.currentTime + 0.4);
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
    osc.onended = () => ctx.close();
  } catch {
    // audio is decorative; ignore failures
  }
}

export const ArcReactorCore: React.FC<ArcReactorCoreProps> = React.memo(({
  statusText = 'ONLINE',
  onSelectTag,
  headerPlacement = 'inline',
}) => {
  const [snap, setSnap] = useState<PresenceSnapshot>(presence.get());
  const [boostKey, setBoostKey] = useState(0);
  const [hoveredTag, setHoveredTag] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const coreElementRef = useRef<HTMLDivElement>(null);
  const barsRef = useRef<HTMLDivElement>(null);
  const tiltRaf = useRef<number | null>(null);

  useEffect(() => presence.subscribe(setSnap), []);
  const [affect, setAffect] = useState<Affect>(presence.affect);
  useEffect(() => presence.onAffect(setAffect), []);
  const mood = moodWords(affect);

  // Equaliser bars follow the real voice level; idle modes get a gentle synthetic sway.
  // Heights are written straight to the DOM so React never re-renders per frame.
  useEffect(() => {
    const tick = (now: number) => {
      const bars = barsRef.current?.children;
      if (!bars) return;
      const mode = presence.get().mode;
      const voice = mode === 'listening' || mode === 'speaking';
      for (let i = 0; i < bars.length; i++) {
        const sway = 0.5 + 0.5 * Math.sin(now / (mode === 'thinking' ? 140 : 520) + i * 0.9);
        const v = voice ? 0.15 + presence.level * BAR_SHAPE[i] * (0.7 + 0.3 * sway) : 0.2 + 0.25 * sway * BAR_SHAPE[i];
        (bars[i] as HTMLElement).style.transform = `scaleY(${Math.min(1, v).toFixed(3)})`;
      }
    };
    // Smooth when her voice moves them; a slow sway at rest doesn't need 60 fps.
    return startFrameLoop(tick, () => (presence.get().mode === 'idle' ? 12 : 60));
  }, []);

  const accent = ACCENT[snap.mode];

  const handleCoreClick = () => {
    setBoostKey((k) => k + 1);
    playCorePulseAudio();
  };

  // Parallax tilt, applied directly to the DOM via rAF.
  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (tiltRaf.current) return;
    const { clientX, clientY } = e;
    tiltRaf.current = requestAnimationFrame(() => {
      tiltRaf.current = null;
      if (!containerRef.current || !coreElementRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = ((clientX - rect.left) / rect.width - 0.5) * 2;
      const y = ((clientY - rect.top) / rect.height - 0.5) * 2;
      coreElementRef.current.style.transform = `perspective(800px) rotateX(${-y * 8}deg) rotateY(${x * 8}deg)`;
    });
  };

  const handleMouseLeave = () => {
    if (tiltRaf.current) cancelAnimationFrame(tiltRaf.current);
    tiltRaf.current = null;
    if (coreElementRef.current) coreElementRef.current.style.transform = 'perspective(800px)';
    setHoveredTag(null);
  };

  return (
    <div
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      style={{ ['--accent' as string]: accent }}
      className="relative flex flex-col items-center justify-center w-full h-full max-w-[620px] max-h-[620px] mx-auto select-none"
    >
      {/* Name plate + one status LCD (state, voice bars, mood) */}
      <div className={headerPlacement === 'top' ? 'sk-top-capsule' : 'flex flex-col items-center mb-2 z-20'} aria-live="polite">
        <span className="sk-brand">FRIDAY</span>
        <div className={`sk-lcd sk-status-strip ${headerPlacement === 'top' ? '' : 'mt-2'}`} style={{ ['--lcd' as string]: accent }}>
          <span className="sk-status-text">{statusLabel(snap, statusText)}</span>
          <div ref={barsRef} className="flex items-center gap-[3px] h-3.5">
            {BAR_SHAPE.map((_, i) => (
              <span key={i} className="w-[2px] h-3.5 rounded-full origin-center sk-status-bar" style={{ transform: 'scaleY(0.3)' }} />
            ))}
          </div>
          {(hoveredTag || mood.length > 0) && (
            <span
              className="sk-status-mood"
              title={`Computed affect state: valence ${affect.valence.toFixed(2)} · arousal ${affect.arousal.toFixed(2)} · curiosity ${affect.curiosity.toFixed(2)} · caution ${affect.caution.toFixed(2)}`}
            >
              {hoveredTag ?? mood.join(' · ')}
            </span>
          )}
        </div>
      </div>

      {/* Left tags */}
      <div className="absolute left-2 top-1/2 -translate-y-1/2 flex-col gap-2.5 z-20 sk-tags">
        {leftTags.map((item) => (
          <button
            key={item.label}
            onClick={() => onSelectTag?.(item.label)}
            onMouseEnter={() => setHoveredTag(item.desc)}
            onMouseLeave={() => setHoveredTag(null)}
            className="sk-tag-plate group"
            title={item.desc}
          >
            <span className="sk-tag-plate-text">{item.label}</span>
          </button>
        ))}
      </div>

      {/* Right tags */}
      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex-col items-end gap-2.5 z-20 sk-tags">
        {rightTags.map((item) => (
          <button
            key={item.label}
            onClick={() => onSelectTag?.(item.label)}
            onMouseEnter={() => setHoveredTag(item.desc)}
            onMouseLeave={() => setHoveredTag(null)}
            className="sk-tag-plate group"
            title={item.desc}
          >
            <span className="sk-tag-plate-text">{item.label}</span>
          </button>
        ))}
      </div>

      {/* Reactor (WebGL) with parallax tilt */}
      <div
        ref={coreElementRef}
        onClick={handleCoreClick}
        title="Click for overdrive"
        style={{ transform: 'perspective(800px)', transition: 'transform 0.12s ease-out' }}
        className="relative w-[360px] h-[360px] md:w-[420px] md:h-[420px] cursor-pointer will-change-transform"
      >
        {/* Static fallback glow, visible if WebGL is unavailable */}
        <div
          className="absolute inset-[18%] rounded-full opacity-40 transition-colors duration-500"
          style={{ background: 'radial-gradient(circle, var(--accent) 0%, transparent 70%)' }}
        />
        <ReactorCanvas className="absolute inset-0 w-full h-full" boostKey={boostKey} />
      </div>

      {/* Projector pedestal */}
      <div className="relative -mt-10 flex flex-col items-center w-full max-w-[320px] pointer-events-none">
        <div
          className="w-28 h-12 blur-md -mb-4 opacity-50 transition-colors duration-500"
          style={{ background: 'linear-gradient(to top, var(--accent), transparent)' }}
        />
        <div className="relative w-64 h-8 flex items-center justify-center">
          <div className="absolute w-60 h-6 rounded-[100%] border transition-colors duration-500" style={{ borderColor: 'var(--accent)', boxShadow: '0 0 15px var(--accent)', opacity: 0.6 }} />
          <div className="absolute w-44 h-4 rounded-[100%] border transition-colors duration-500" style={{ borderColor: 'var(--accent)', boxShadow: '0 0 20px var(--accent)', opacity: 0.85 }} />
          <div className="absolute w-24 h-2 rounded-[100%] bg-white/90" style={{ boxShadow: '0 0 25px var(--accent)' }} />
        </div>
      </div>
    </div>
  );
});
