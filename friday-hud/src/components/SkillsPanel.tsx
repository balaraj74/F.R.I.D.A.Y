import React, { useState, useEffect, useMemo } from 'react';
import { Brain, Search, Check, X, RefreshCw, FolderGit2, Sparkles, Filter } from 'lucide-react';
import { gateway } from '../services/gateway-ws';
import { SkillItem } from '../types';

export const SkillsPanel: React.FC = () => {
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [workspaceDir, setWorkspaceDir] = useState('');

  const loadSkills = async () => {
    setLoading(true);
    try {
      const data = await gateway.getSkills();
      setSkills(data.skills);
      if (data.workspaceDir) setWorkspaceDir(data.workspaceDir);
    } catch (e) {
      console.warn('Failed to load skills:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSkills();
  }, []);

  const handleToggle = async (skill: SkillItem) => {
    const nextState = !skill.enabled;
    setSkills((prev) =>
      prev.map((s) => (s.name === skill.name ? { ...s, enabled: nextState } : s))
    );
    try {
      await gateway.updateSkill(skill.name, nextState);
    } catch (e) {
      console.warn('Failed to update skill:', e);
    }
  };

  const filteredSkills = useMemo(() => {
    let list = skills;
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          (s.description && s.description.toLowerCase().includes(q))
      );
    }
    return list;
  }, [skills, query]);

  return (
    <div className="flex-1 flex flex-col p-4 overflow-hidden space-y-4">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 border-b border-cyan-500/20 gap-2">
        <div>
          <h2 className="text-lg font-bold font-hud tracking-wider text-cyan-300 flex items-center gap-2">
            <Brain className="w-5 h-5 text-cyan-400 animate-pulse" />
            SKILLS ({skills.length.toLocaleString()} LOADED)
          </h2>
          <p className="text-xs font-mono text-slate-400">
            Autonomous capability packages from FRIDAY's skills library
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={loadSkills}
            disabled={loading}
            className="px-3 py-1.5 rounded-xl border border-cyan-500/40 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 text-xs font-mono flex items-center gap-1.5 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            REFRESH
          </button>
        </div>
      </div>

      {/* Search and Filters */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-cyan-400" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search skills by keyword (e.g. docker, react, postgres, python, flutter)..."
            className="w-full pl-10 pr-4 py-2 rounded-xl hud-glass-panel border border-cyan-500/30 text-xs font-mono text-cyan-100 placeholder-slate-500 focus:outline-none focus:border-cyan-400"
          />
        </div>
        <span className="text-xs font-mono text-slate-400 whitespace-nowrap">
          {filteredSkills.length} matches
        </span>
      </div>

      {/* Skills Grid */}
      <div className="flex-1 overflow-y-auto grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 pr-1">
        {filteredSkills.slice(0, 150).map((skill) => (
          <div
            key={skill.name}
            className={`p-3 rounded-xl hud-glass-panel border transition-all flex flex-col justify-between ${
              skill.enabled
                ? 'border-cyan-500/30 hover:border-cyan-400/60 shadow-[0_0_15px_rgba(0,229,255,0.08)]'
                : 'border-slate-800 opacity-60'
            }`}
          >
            <div>
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <span className="text-xs font-bold font-hud text-cyan-200 truncate" title={skill.name}>
                  {skill.name}
                </span>
                <span
                  className={`px-1.5 py-0.5 rounded text-[9px] font-mono uppercase ${
                    skill.enabled
                      ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-400/40'
                      : 'bg-slate-800 text-slate-400'
                  }`}
                >
                  {skill.enabled ? 'ACTIVE' : 'MUTED'}
                </span>
              </div>

              <p className="text-[11px] font-mono text-slate-400 line-clamp-2 leading-relaxed">
                {skill.description || 'No description available for this skill.'}
              </p>
            </div>

            <div className="mt-3 pt-2 border-t border-cyan-500/15 flex items-center justify-between text-[10px] font-mono text-slate-400">
              <span className="flex items-center gap-1 text-cyan-400/80">
                <FolderGit2 className="w-3 h-3" /> {skill.source || 'skills-library'}
              </span>

              <button
                onClick={() => handleToggle(skill)}
                className={`px-2 py-0.5 rounded cursor-pointer transition-colors ${
                  skill.enabled
                    ? 'text-cyan-300 hover:text-red-300'
                    : 'text-slate-400 hover:text-cyan-300'
                }`}
              >
                {skill.enabled ? 'Disable' : 'Enable'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

