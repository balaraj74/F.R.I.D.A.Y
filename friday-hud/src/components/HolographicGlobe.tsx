import React, { useEffect, useState } from 'react';

// World clocks as small analog dials on a glass panel. Bengaluru (home) is left out: it is
// already on the greeting display. Kept under the old export name so App.tsx stays unchanged.

const ZONES = [
  { city: 'New York', tz: 'America/New_York' },
  { city: 'London', tz: 'Europe/London' },
  { city: 'Singapore', tz: 'Asia/Singapore' },
  { city: 'Tokyo', tz: 'Asia/Tokyo' },
];

function partsIn(tz: string, now: Date) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: 'numeric', hour12: false });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  const h = Number(p.hour) % 24;
  const m = Number(p.minute);
  return { h, m };
}

const MiniClock: React.FC<{ city: string; h: number; m: number }> = ({ city, h, m }) => {
  const hourDeg = ((h % 12) + m / 60) * 30;
  const minDeg = m * 6;
  const night = h < 6 || h >= 19;
  return (
    <div className="flex flex-col items-center gap-1.5 min-w-0">
      <svg viewBox="0 0 48 48" className="w-12 h-12 sk-gauge" aria-label={`${city} ${h}:${String(m).padStart(2, '0')}`}>
        <defs>
          <linearGradient id={`wc-bezel-${city}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#d9dee3" />
            <stop offset="0.5" stopColor="#4c545e" />
            <stop offset="1" stopColor="#9aa3ad" />
          </linearGradient>
        </defs>
        <circle cx="24" cy="24" r="23" fill={`url(#wc-bezel-${city})`} />
        <circle cx="24" cy="24" r="20.5" fill={night ? '#0a0f15' : '#1a2430'} />
        {Array.from({ length: 12 }).map((_, i) => {
          const a = (i * 30 * Math.PI) / 180;
          const r1 = i % 3 === 0 ? 15.5 : 17;
          return (
            <line key={i} x1={24 + Math.sin(a) * r1} y1={24 - Math.cos(a) * r1} x2={24 + Math.sin(a) * 19} y2={24 - Math.cos(a) * 19} stroke="#a9b6c3" strokeWidth={i % 3 === 0 ? 1.3 : 0.6} />
          );
        })}
        <line x1="24" y1="24" x2="24" y2="13" stroke="#e6ecf1" strokeWidth="2" strokeLinecap="round" transform={`rotate(${hourDeg} 24 24)`} />
        <line x1="24" y1="26" x2="24" y2="8" stroke="#ff6a3d" strokeWidth="1" strokeLinecap="round" transform={`rotate(${minDeg} 24 24)`} />
        <circle cx="24" cy="24" r="1.8" fill="#cfd6dc" />
      </svg>
      <span className="sk-engraved sk-engraved-sm truncate max-w-full">{city}</span>
      <span className="sk-readout">{`${h % 12 || 12}:${String(m).padStart(2, '0')}${h < 12 ? 'a' : 'p'}`}</span>
    </div>
  );
};

export const HolographicGlobe: React.FC = () => {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="sk-plate">
      <div className="sk-plate-head">
        <span className="sk-engraved">World</span>
      </div>
      <div className="grid grid-cols-4 gap-1">
        {ZONES.map((z) => {
          const { h, m } = partsIn(z.tz, now);
          return <MiniClock key={z.tz} city={z.city} h={h} m={m} />;
        })}
      </div>
    </div>
  );
};
