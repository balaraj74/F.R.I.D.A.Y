import React, { useEffect } from 'react';
import { Check, GitBranch, RefreshCw, X } from 'lucide-react';
import { relativeTime, useProjects } from '../services/projects';

interface ProjectsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

// Pick the active project from real git repositories (sorted by most recent commit).
export const ProjectsModal: React.FC<ProjectsModalProps> = ({ isOpen, onClose }) => {
  const { projects, active, setActive, refresh, loading } = useProjects();

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-md"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Choose active project"
    >
      <div
        className="w-full max-w-2xl hud-glass-panel border border-cyan-400/50 p-6 rounded-2xl shadow-[0_0_50px_rgba(0,229,255,0.3)] bg-slate-950/95 max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between pb-4 border-b border-cyan-500/30">
          <div>
            <h3 className="text-lg font-bold font-hud text-cyan-300">PROJECTS</h3>
            <p className="text-xs text-slate-400 font-mono">
              {loading ? 'Scanning…' : `${projects?.length ?? 0} git projects in your home folder · most recent first`}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => void refresh()}
              aria-label="Rescan projects"
              className="p-1.5 rounded-lg text-slate-400 hover:text-cyan-300 hover:bg-cyan-500/20"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
            <button
              onClick={onClose}
              aria-label="Close"
              className="p-1.5 rounded-lg text-slate-400 hover:text-cyan-300 hover:bg-cyan-500/20"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto py-4 grid grid-cols-1 md:grid-cols-2 gap-3">
          {!loading && (projects?.length ?? 0) === 0 && (
            <p className="text-sm text-slate-400 font-mono col-span-full">
              No git projects found (or not running inside the desktop app).
            </p>
          )}
          {projects?.map((p) => {
            const isActive = active?.path === p.path;
            return (
              <button
                key={p.path}
                onClick={() => {
                  setActive(p.path);
                  onClose();
                }}
                className={`text-left p-3.5 rounded-xl bg-slate-900/70 border transition-all cursor-pointer flex flex-col gap-2 ${
                  isActive
                    ? 'border-cyan-300 shadow-[0_0_15px_rgba(0,229,255,0.25)]'
                    : 'border-cyan-500/25 hover:border-cyan-400 hover:bg-cyan-950/40'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <h4 className="text-sm font-bold font-hud text-slate-100 truncate">{p.name}</h4>
                  {isActive ? (
                    <span className="flex items-center gap-1 text-[10px] text-emerald-300 font-mono shrink-0">
                      <Check className="w-3 h-3" /> Active
                    </span>
                  ) : (
                    <span className="text-[10px] text-slate-500 font-mono shrink-0">{relativeTime(p.lastCommitAt)}</span>
                  )}
                </div>
                {p.description && <p className="text-[11px] text-slate-400 leading-snug line-clamp-2">{p.description}</p>}
                <div className="flex items-center gap-3 text-[10px] font-mono text-slate-400 flex-wrap">
                  {p.branch && (
                    <span className="flex items-center gap-1">
                      <GitBranch className="w-3 h-3" /> {p.branch}
                    </span>
                  )}
                  {p.uncommitted > 0 && <span className="text-amber-300">{p.uncommitted} uncommitted</span>}
                  {p.ahead > 0 && <span className="text-amber-300">{p.ahead} unpushed</span>}
                </div>
                {p.tech.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {p.tech.map((t) => (
                      <span key={t} className="px-1.5 py-0.5 rounded text-[9px] bg-slate-800 text-cyan-300/90 font-mono border border-cyan-500/20">
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};
