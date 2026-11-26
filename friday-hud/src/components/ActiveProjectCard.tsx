import React from 'react';
import { ChevronRight, GitBranch } from 'lucide-react';
import { relativeTime, useProjects } from '../services/projects';

interface ActiveProjectCardProps {
  onChangeProject?: () => void;
}

// The project Sir is focused on, from its real git state (no invented progress numbers),
// shown as an engraved nameplate with a small status readout.
export const ActiveProjectCard: React.FC<ActiveProjectCardProps> = ({ onChangeProject }) => {
  const { active, loading } = useProjects();

  return (
    <div className="sk-plate">
      <div className="sk-plate-head">
        <span className="sk-engraved">Project</span>
        <button type="button" onClick={onChangeProject} className="sk-key sk-key-sm flex items-center gap-0.5" title="Choose another project">
          Change <ChevronRight className="w-3 h-3" />
        </button>
      </div>

      {!active ? (
        <p className="sk-muted px-2">{loading ? 'Scanning your projects…' : 'No git projects found in your home folder.'}</p>
      ) : (
        <div className="flex flex-col gap-2.5 min-w-0">
          <div className="sk-nameplate min-w-0">
            <div className="sk-nameplate-title truncate">{active.name}</div>
            {active.description && <div className="sk-muted line-clamp-1">{active.description}</div>}
          </div>

          <div className="sk-lcd sk-lcd-tight">
            <div className="flex items-center justify-between gap-2 min-w-0">
              <span className="sk-lcd-small truncate" title={active.lastCommitMessage}>
                {relativeTime(active.lastCommitAt).toUpperCase()} · {active.lastCommitMessage || 'NO COMMITS YET'}
              </span>
            </div>
            <div className="flex items-center gap-3 mt-1 flex-wrap">
              {active.branch && (
                <span className="sk-lcd-small flex items-center gap-1 min-w-0">
                  <GitBranch className="w-3 h-3 shrink-0" />
                  <span className="truncate max-w-[120px]">{active.branch}</span>
                </span>
              )}
              <span className={`sk-lcd-small ${active.uncommitted ? 'sk-lcd-amber' : ''}`}>{active.uncommitted} CHANGED</span>
              {active.ahead > 0 && <span className="sk-lcd-small sk-lcd-amber">{active.ahead} UNPUSHED</span>}
              {active.behind > 0 && <span className="sk-lcd-small">{active.behind} BEHIND</span>}
            </div>
          </div>

          {active.tech.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-0.5">
              {active.tech.slice(0, 5).map((t) => (
                <span key={t} className="sk-tag">
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
