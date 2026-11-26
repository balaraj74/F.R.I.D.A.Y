import React from 'react';
import {
  Blocks,
  Home,
  MessageSquare,
  Radio,
  Brain,
  Clock,
  ShieldCheck,
  Terminal,
  Settings,
  Dna,
  Briefcase,
  HardDrive,
  UserRound,
} from 'lucide-react';

export type NavItem =
  | 'home'
  | 'avatar'
  | 'chat'
  | 'abilities'
  | 'workspace'
  | 'channels'
  | 'skills'
  | 'evolution'
  | 'opportunities'
  | 'cron'
  | 'approvals'
  | 'logs'
  | 'settings';

interface SidebarNavProps {
  activeTab: NavItem;
  onSelectTab: (tab: NavItem) => void;
}

export const SidebarNav: React.FC<SidebarNavProps> = ({ activeTab, onSelectTab }) => {
  const items: { id: NavItem; label: string; icon: React.ReactNode }[] = [
    { id: 'home', label: 'HUD', icon: <Home className="w-5 h-5" /> },
    { id: 'avatar', label: 'AVATAR', icon: <UserRound className="w-5 h-5" /> },
    { id: 'chat', label: 'CHAT', icon: <MessageSquare className="w-5 h-5" /> },
    { id: 'abilities', label: 'ABILITIES', icon: <Blocks className="w-5 h-5" /> },
    { id: 'workspace', label: 'WORKSPACE', icon: <HardDrive className="w-5 h-5" /> },
    { id: 'channels', label: 'COMMS', icon: <Radio className="w-5 h-5" /> },
    { id: 'skills', label: 'SKILLS', icon: <Brain className="w-5 h-5" /> },
    { id: 'evolution', label: 'AGI EVO', icon: <Dna className="w-5 h-5" /> },
    { id: 'opportunities', label: 'BOUNTIES', icon: <Briefcase className="w-5 h-5" /> },
    { id: 'cron', label: 'CRON', icon: <Clock className="w-5 h-5" /> },
    { id: 'approvals', label: 'SECURITY', icon: <ShieldCheck className="w-5 h-5" /> },
    { id: 'logs', label: 'LOGS', icon: <Terminal className="w-5 h-5" /> },
    { id: 'settings', label: 'CONFIG', icon: <Settings className="w-5 h-5" /> },
  ];

  return (
    <aside className="h-full overflow-y-auto shrink-0 flex flex-col items-center py-4 px-2 border-r border-cyan-500/20 bg-slate-950/60 w-20 z-20 app-no-drag select-none">
      <nav className="flex flex-col gap-2.5 w-full">
        {items.map((item) => {
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelectTab(item.id)}
              className={`group relative flex flex-col items-center justify-center py-2 px-1 rounded-xl cursor-pointer transition-all duration-300 ${
                isActive
                  ? 'bg-cyan-500/20 text-cyan-300 shadow-[0_0_20px_rgba(0,229,255,0.4)] border border-cyan-400/50'
                  : 'text-slate-400 hover:text-cyan-200 hover:bg-slate-900/60'
              }`}
            >
              {/* Active neon left edge bar */}
              {isActive && (
                <div className="absolute left-0 top-2 bottom-2 w-1 bg-cyan-400 rounded-r shadow-[0_0_8px_#00e5ff]" />
              )}
              <div className="transition-transform group-hover:scale-110 duration-200">
                {item.icon}
              </div>
              <span className="text-[9px] font-hud tracking-wider mt-1 font-semibold">
                {item.label}
              </span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
};
