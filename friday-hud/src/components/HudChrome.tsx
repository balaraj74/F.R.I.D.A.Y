import React, { useEffect, useRef, useState } from 'react';
import {
  Blocks,
  Bot,
  BotOff,
  Brain,
  Briefcase,
  Clock,
  Dna,
  HardDrive,
  Home,
  Maximize2,
  MessageSquare,
  Minimize2,
  Minus,
  Pin,
  Radio,
  Settings,
  ShieldCheck,
  Terminal,
  UserRound,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import type { NavItem } from './SidebarNav';

// Skeuomorphic window chrome: no top bar and no sidebar. The FRIDAY icon (top-left) is home and
// opens the section launcher; a few quiet icon buttons (top-right) replace the header controls.
// An invisible strip along the top keeps the frameless window draggable.

const SECTIONS: { id: NavItem; label: string; icon: React.ReactNode }[] = [
  { id: 'home', label: 'Home', icon: <Home /> },
  { id: 'chat', label: 'Chat', icon: <MessageSquare /> },
  { id: 'avatar', label: 'Avatar', icon: <UserRound /> },
  { id: 'abilities', label: 'Abilities', icon: <Blocks /> },
  { id: 'workspace', label: 'Workspace', icon: <HardDrive /> },
  { id: 'channels', label: 'Comms', icon: <Radio /> },
  { id: 'skills', label: 'Skills', icon: <Brain /> },
  { id: 'evolution', label: 'Evolution', icon: <Dna /> },
  { id: 'opportunities', label: 'Bounties', icon: <Briefcase /> },
  { id: 'cron', label: 'Schedule', icon: <Clock /> },
  { id: 'approvals', label: 'Security', icon: <ShieldCheck /> },
  { id: 'logs', label: 'Logs', icon: <Terminal /> },
  { id: 'settings', label: 'Settings', icon: <Settings /> },
];

type Size = 'compact' | 'medium' | 'full';

interface Props {
  activeTab: NavItem;
  onSelectTab: (tab: NavItem) => void;
  currentSize: Size;
  onSetSize: (size: Size) => void;
  isPinned: boolean;
  onTogglePin: () => void;
  isVoiceMuted: boolean;
  onToggleVoice: () => void;
  isSpeaking: boolean;
  onMinimize: () => void;
  onClose: () => void;
  connected: boolean;
}

const NEXT_SIZE: Record<Size, Size> = { compact: 'medium', medium: 'full', full: 'compact' };
const SIZE_LABEL: Record<Size, string> = { compact: 'Mini', medium: 'Medium', full: 'Full' };

const IconBtn: React.FC<{
  title: string;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}> = ({ title, onClick, active, danger, children }) => (
  <button
    type="button"
    title={title}
    aria-label={title}
    onClick={onClick}
    className={`sk-btn ${active ? 'sk-btn-active' : ''} ${danger ? 'sk-btn-danger' : ''}`}
  >
    {children}
  </button>
);

export const HudChrome: React.FC<Props> = (p) => {
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [autonomyPaused, setAutonomyPaused] = useState<boolean | null>(null);
  const launcherRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.electronAPI?.getAutonomy?.().then((s) => setAutonomyPaused(s.paused)).catch(() => {});
  }, []);

  // Close the launcher with Escape or a click outside it.
  useEffect(() => {
    if (!launcherOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setLauncherOpen(false);
    const onDown = (e: MouseEvent) => {
      if (!launcherRef.current?.contains(e.target as Node)) setLauncherOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
    };
  }, [launcherOpen]);

  const toggleAutonomy = async () => {
    if (autonomyPaused === null || !window.electronAPI?.setAutonomy) return;
    const s = await window.electronAPI.setAutonomy(!autonomyPaused);
    setAutonomyPaused(s.paused);
  };

  // Icon: away from home it goes home; at home it opens the launcher.
  const onIcon = () => {
    if (p.activeTab !== 'home') {
      p.onSelectTab('home');
      setLauncherOpen(false);
    } else {
      setLauncherOpen((v) => !v);
    }
  };

  const current = SECTIONS.find((s) => s.id === p.activeTab);

  return (
    <>
      {/* Invisible drag strip (window move); controls sit above it and stay clickable. */}
      <div className="absolute top-0 left-0 right-0 h-10 z-30 app-drag" />

      {/* FRIDAY icon = home + launcher */}
      <div ref={launcherRef} className="absolute top-3 left-3 z-40 app-no-drag">
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={onIcon}
            title={p.activeTab === 'home' ? 'Open sections' : 'Back to home'}
            aria-label={p.activeTab === 'home' ? 'Open sections' : 'Back to home'}
            aria-expanded={launcherOpen}
            className="sk-icon-btn"
          >
            <img src="./friday-icon.png" alt="FRIDAY" draggable={false} />
            <span className={`sk-icon-lamp ${p.connected ? 'is-on' : ''}`} />
          </button>
          {p.activeTab !== 'home' && current && (
            <span className="text-[11px] tracking-[0.2em] uppercase text-slate-400">{current.label}</span>
          )}
        </div>

        {launcherOpen && (
          <div className="sk-launcher" role="menu">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                role="menuitem"
                onClick={() => {
                  p.onSelectTab(s.id);
                  setLauncherOpen(false);
                }}
                className={`sk-launcher-key ${p.activeTab === s.id ? 'is-active' : ''}`}
              >
                <span className="sk-launcher-icon">{s.icon}</span>
                <span>{s.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Window controls */}
      <div className="absolute top-3 right-3 z-40 flex items-center gap-1 app-no-drag sk-controls">
        {autonomyPaused !== null && (
          <IconBtn
            title={autonomyPaused ? 'Autonomy paused — click to resume' : 'Autonomy on — click to pause'}
            onClick={() => void toggleAutonomy()}
            active={!autonomyPaused}
            danger={autonomyPaused}
          >
            {autonomyPaused ? <BotOff /> : <Bot />}
          </IconBtn>
        )}
        <IconBtn title={p.isVoiceMuted ? 'Unmute voice' : 'Mute voice'} onClick={p.onToggleVoice} active={!p.isVoiceMuted}>
          {p.isVoiceMuted ? <VolumeX /> : <Volume2 className={p.isSpeaking ? 'animate-pulse' : ''} />}
        </IconBtn>
        <IconBtn title={p.isPinned ? 'Unpin from desktop' : 'Pin to desktop'} onClick={p.onTogglePin} active={p.isPinned}>
          <Pin />
        </IconBtn>
        <IconBtn
          title={`Size: ${SIZE_LABEL[p.currentSize]} — click for ${SIZE_LABEL[NEXT_SIZE[p.currentSize]]}`}
          onClick={() => p.onSetSize(NEXT_SIZE[p.currentSize])}
        >
          {p.currentSize === 'full' ? <Minimize2 /> : <Maximize2 />}
        </IconBtn>
        <IconBtn title="Minimize" onClick={p.onMinimize}>
          <Minus />
        </IconBtn>
        <IconBtn title="Close FRIDAY" onClick={p.onClose} danger>
          <X />
        </IconBtn>
      </div>
    </>
  );
};
