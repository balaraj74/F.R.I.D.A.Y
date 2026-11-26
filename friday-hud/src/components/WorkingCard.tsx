import React, { useEffect, useRef, useState } from 'react';
import { Bot } from 'lucide-react';
import { WorkTrace } from './WorkTrace';
import { onTurnHeadline, toolPhrase } from '../services/narration';
import type { ActivityStep } from '../types';

// Shown from the moment a message is sent until the reply arrives, so a long silent model
// phase never looks like a freeze: elapsed time, what's happening now, and the live steps.

interface Props {
  thinking?: string;
  activities: ActivityStep[];
}

const fmt = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export const WorkingCard: React.FC<Props> = ({ thinking, activities }) => {
  const startedAt = useRef(Date.now());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const [headline, setHeadline] = useState('');
  useEffect(() => onTurnHeadline(setHeadline), []);

  const tools = activities.filter((a) => a.type === 'action' && a.toolCall);
  const running = tools.find((a) => a.status === 'running')?.toolCall;
  const lastStep = activities[activities.length - 1];
  const phase = running
    ? `${toolPhrase(running.name, running.input)}…`
    : lastStep?.type === 'thinking'
      ? 'Thinking…'
      : tools.length
      ? 'Thinking about the results…'
      : headline
        ? `${headline.replace(/[.!]+$/, '')}…`
        : 'Thinking…';

  return (
    <div className="w-full max-w-[85%] flex flex-col gap-1.5" aria-live="polite">
      <div className="flex items-center gap-2">
        <Bot className="w-3.5 h-3.5 text-cyan-400" />
        <span className="text-[10px] font-mono text-cyan-300 font-bold">FRIDAY</span>
        <span className="text-[10px] font-mono text-slate-500 tabular-nums">{fmt(now - startedAt.current)}</span>
      </div>
      <div className="flex items-center gap-3 px-4 py-3 rounded-2xl rounded-tl-sm border border-amber-400/30 bg-amber-950/15">
        <span className="flex gap-1" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="w-1.5 h-1.5 rounded-full bg-amber-300 animate-bounce"
              style={{ animationDelay: `${i * 0.15}s` }}
            />
          ))}
        </span>
        <span className="text-sm text-amber-100">{phase}</span>
      </div>
      {(activities.length > 0 || thinking) && (
        <WorkTrace thinking={thinking} activities={activities} isLive defaultExpanded />
      )}
    </div>
  );
};
