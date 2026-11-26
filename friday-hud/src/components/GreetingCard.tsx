import React, { useEffect, useState } from 'react';
import { fetchWeather, type Weather } from '../services/weather';

interface GreetingCardProps {
  userName?: string;
  onActionClick: (prompt: string) => void;
}

const ACTIONS = [
  { label: 'Plan day', prompt: 'FRIDAY, plan my daily schedule and prioritize my highest impact tasks for today.' },
  { label: 'Project', prompt: 'FRIDAY, let us continue work on my active project. Give me the current status and next milestones.' },
  { label: 'Research', prompt: 'FRIDAY, I want to research a technical topic using your scout tools.' },
  { label: 'Analyze', prompt: 'FRIDAY, analyze system performance and data metrics from our active runs.' },
  { label: 'My notes', prompt: 'FRIDAY, summarize my latest memory notes and daily logs from the workspace.' },
  { label: 'Brainstorm', prompt: 'FRIDAY, let us brainstorm new architectural ideas and capabilities.' },
];

function greeting(hour: number) {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

// Backlit glass display (clock, date, weather) on a metal plate, with physical keys below.
export const GreetingCard: React.FC<GreetingCardProps> = ({ userName = 'Balaraj', onActionClick }) => {
  const [now, setNow] = useState(new Date());
  const [weather, setWeather] = useState<Weather | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    const load = () => fetchWeather(ctrl.signal).then(setWeather);
    load();
    const t = setInterval(load, 15 * 60 * 1000);
    return () => {
      clearInterval(t);
      ctrl.abort();
    };
  }, []);

  const hh = now.getHours() % 12 || 12;
  const mm = String(now.getMinutes()).padStart(2, '0');
  const colonOn = now.getSeconds() % 2 === 0;
  const ampm = now.getHours() < 12 ? 'AM' : 'PM';
  const date = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase();

  return (
    <div className="sk-plate">
      <div className="sk-plate-head">
        <span className="sk-engraved">{greeting(now.getHours())}</span>
        <span className="sk-engraved sk-engraved-sm">{userName}</span>
      </div>

      <div className="sk-lcd">
        <div className="flex items-end justify-between">
          <div className="flex items-end">
            <span className="sk-lcd-digits">
              {hh}
              <span style={{ opacity: colonOn ? 1 : 0.15 }}>:</span>
              {mm}
            </span>
            <span className="sk-lcd-small ml-1.5 mb-1.5">{ampm}</span>
          </div>
          {weather && (
            <div className="text-right mb-1">
              <div className="sk-lcd-mid">{weather.tempC}°C</div>
              <div className="sk-lcd-small">{weather.label.toUpperCase()}</div>
            </div>
          )}
        </div>
        <div className="sk-lcd-small mt-1">{date} · BENGALURU</div>
      </div>

      <div className="grid grid-cols-3 gap-2 mt-4">
        {ACTIONS.map((a) => (
          <button key={a.label} type="button" onClick={() => onActionClick(a.prompt)} className="sk-key">
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
};
