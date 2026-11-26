import React from 'react';

// Skeuomorphic analog meter: machined bezel, printed dial face with ticks and a red zone, a
// needle that springs to the value (CSS overshoot curve), a metal hub and a glass reflection.

interface Props {
  label: string;
  value: number | null;
  size?: number;
  redFrom?: number;
}

const START = -120; // degrees, 0 = straight up
const SWEEP = 240;

function polar(cx: number, cy: number, r: number, deg: number) {
  const a = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

function arcPath(cx: number, cy: number, r: number, from: number, to: number) {
  const s = polar(cx, cy, r, from);
  const e = polar(cx, cy, r, to);
  const large = to - from > 180 ? 1 : 0;
  return `M ${s.x} ${s.y} A ${r} ${r} 0 ${large} 1 ${e.x} ${e.y}`;
}

let gaugeSeq = 0;

export const AnalogGauge: React.FC<Props> = React.memo(({ label, value, size = 112, redFrom = 80 }) => {
  const id = React.useMemo(() => `g${++gaugeSeq}`, []);
  const v = value == null ? 0 : Math.max(0, Math.min(100, value));
  const angle = START + (v / 100) * SWEEP;
  const c = 60;
  const ticks: React.ReactNode[] = [];
  for (let i = 0; i <= 50; i++) {
    const deg = START + (i / 50) * SWEEP;
    const major = i % 5 === 0;
    const p1 = polar(c, c, 44, deg);
    const p2 = polar(c, c, major ? 37 : 40.5, deg);
    ticks.push(
      <line
        key={i}
        x1={p1.x}
        y1={p1.y}
        x2={p2.x}
        y2={p2.y}
        stroke={i * 2 >= redFrom ? '#e0524a' : '#c9d3dc'}
        strokeWidth={major ? 1.4 : 0.6}
        strokeLinecap="round"
      />,
    );
    if (major && i % 10 === 0) {
      const t = polar(c, c, 30.5, deg);
      ticks.push(
        <text key={`t${i}`} x={t.x} y={t.y + 2.2} textAnchor="middle" fontSize="7" fill="#a9b8c6" fontFamily="Rajdhani">
          {i * 2}
        </text>,
      );
    }
  }

  return (
    <div className="sk-gauge" style={{ width: '100%', maxWidth: size, minWidth: 0 }}>
      <svg viewBox="0 0 120 120" width="100%" style={{ display: 'block' }} aria-label={`${label} ${value ?? 'unknown'}%`}>
        <defs>
          <linearGradient id={`${id}-bezel`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#d9dee3" />
            <stop offset="0.35" stopColor="#6b7480" />
            <stop offset="0.65" stopColor="#2c323a" />
            <stop offset="1" stopColor="#9aa3ad" />
          </linearGradient>
          <radialGradient id={`${id}-face`} cx="0.5" cy="0.42" r="0.62">
            <stop offset="0" stopColor="#1d2733" />
            <stop offset="1" stopColor="#070b10" />
          </radialGradient>
          <radialGradient id={`${id}-hub`} cx="0.35" cy="0.3" r="0.8">
            <stop offset="0" stopColor="#f2f5f8" />
            <stop offset="0.5" stopColor="#7c8794" />
            <stop offset="1" stopColor="#262c33" />
          </radialGradient>
          <linearGradient id={`${id}-glass`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="rgba(255,255,255,0.22)" />
            <stop offset="1" stopColor="rgba(255,255,255,0)" />
          </linearGradient>
        </defs>

        {/* Bezel ring and recessed face */}
        <circle cx={c} cy={c} r="58" fill={`url(#${id}-bezel)`} />
        <circle cx={c} cy={c} r="53.5" fill="#05080c" />
        <circle cx={c} cy={c} r="52" fill={`url(#${id}-face)`} />

        {/* Red zone band */}
        <path
          d={arcPath(c, c, 46.5, START + (redFrom / 100) * SWEEP, START + SWEEP)}
          stroke="rgba(224,82,74,0.55)"
          strokeWidth="3"
          fill="none"
        />
        {/* Value band: backlit like the reactor */}
        {value != null && v > 0 && (
          <path d={arcPath(c, c, 46.5, START, angle)} stroke="rgba(94,234,255,0.5)" strokeWidth="3" fill="none" />
        )}
        {ticks}

        <text x={c} y="82" textAnchor="middle" fontSize="8.6" letterSpacing="1.2" fontWeight="700" fill="#93a3b2" fontFamily="Rajdhani">
          {label.toUpperCase()}
        </text>
        {/* LCD readout */}
        <rect x="44" y="86" width="32" height="12" rx="2" fill="#03141a" stroke="#0d2a33" />
        <text x={c} y="95" textAnchor="middle" fontSize="9.5" fill="#6ff3ff" fontFamily="JetBrains Mono">
          {value == null ? '--' : `${Math.round(v)}%`}
        </text>

        {/* Needle (springs to value) */}
        <g className="sk-needle" style={{ transform: `rotate(${angle}deg)`, transformOrigin: '60px 60px' }}>
          <path d="M 60 66 L 58.6 60 L 60 15 L 61.4 60 Z" fill="#ff6a3d" />
          <path d="M 60 60 L 60 15" stroke="rgba(255,255,255,0.35)" strokeWidth="0.4" />
        </g>
        <circle cx={c} cy={c} r="6.5" fill={`url(#${id}-hub)`} stroke="#11161c" strokeWidth="0.8" />
        <circle cx={c} cy={c} r="1.6" fill="#11161c" />

        {/* Glass reflection */}
        <path d="M 14 50 A 46 46 0 0 1 106 50 A 60 40 0 0 0 14 50 Z" fill={`url(#${id}-glass)`} />
      </svg>
    </div>
  );
});
