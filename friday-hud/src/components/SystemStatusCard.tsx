import React from 'react';
import { SystemStats } from '../types';
import { AnalogGauge } from './AnalogGauge';

interface SystemStatusCardProps {
  stats: SystemStats;
}

// Overall state derived from the real readings (never a fixed "all online").
function overall(stats: SystemStats): { label: string; tone: 'ok' | 'warn' | 'off' } {
  if ([stats.cpu, stats.ram, stats.disk].some((v) => v == null)) return { label: 'Partial data', tone: 'off' };
  if ((stats.ram ?? 0) >= 90 || (stats.disk ?? 0) >= 90 || (stats.battery != null && stats.battery <= 15)) {
    return { label: 'Attention', tone: 'warn' };
  }
  return { label: 'Nominal', tone: 'ok' };
}

/** Small backlit bar meter for the secondary readings. */
const BarMeter: React.FC<{ label: string; value: number | null; redFrom?: number }> = ({ label, value, redFrom = 80 }) => {
  const v = value == null ? null : Math.max(0, Math.min(100, value));
  const tone = v == null ? '' : v >= redFrom ? 'is-high' : v >= redFrom - 15 ? 'is-warn' : '';
  return (
    <div className="sk-bar">
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="sk-engraved sk-engraved-sm">{label}</span>
        <span className="sk-readout">{v == null ? '--' : `${Math.round(v)}%`}</span>
      </div>
      <div className="sk-bar-track">
        <div className={`sk-bar-fill ${tone}`} style={{ width: `${v ?? 0}%` }} />
      </div>
    </div>
  );
};

// Two large analog dials (CPU, memory) and two bar meters (GPU, disk).
export const SystemStatusCard: React.FC<SystemStatusCardProps> = React.memo(({ stats }) => {
  const state = overall(stats);
  return (
    <div className="sk-plate sk-plate-fill">
      <div className="sk-plate-head">
        <span className="sk-engraved">System</span>
        <span className="sk-lamp-wrap">
          <span className={`sk-lamp sk-lamp-${state.tone}`} />
          <span className="sk-engraved sk-engraved-sm">{state.label}</span>
        </span>
      </div>
      <div className="sk-well flex-1 min-h-0 flex flex-col justify-center gap-3 px-3 py-3">
        <div className="grid grid-cols-2 gap-2 place-items-center">
          <AnalogGauge label="CPU" value={stats.cpu} size={150} />
          <AnalogGauge label="Memory" value={stats.ram} size={150} />
        </div>
        <div className="grid grid-cols-2 gap-4 px-1">
          <BarMeter label="GPU" value={stats.gpu} />
          <BarMeter label="Disk" value={stats.disk} redFrom={90} />
        </div>
      </div>
    </div>
  );
});
