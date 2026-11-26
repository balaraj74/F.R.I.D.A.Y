import React, { useState, useEffect } from 'react';
import {
  Briefcase,
  TrendingUp,
  RefreshCw,
  ExternalLink,
  Code2,
  CheckCircle2,
  AlertCircle,
  Clock,
  Sparkles,
  DollarSign,
  FolderOpen,
  Eye,
  X,
  Copy,
  Check,
  FileCode,
  Zap
} from 'lucide-react';

interface Opportunity {
  id: string;
  source: string;
  title: string;
  url: string;
  repo?: string;
  reward_usd: number;
  labels: string[];
  description: string;
  created_at: string;
  status: 'discovered' | 'in_progress' | 'ready_for_approval' | 'submitted' | 'completed';
  matched_skills?: string[];
  feasibility_percent?: number;
  auto_solvable?: boolean;
  workspace_path?: string;
  approval_summary?: string;
}

interface Stats {
  total_earnings_usd: number;
  potential_pipeline_usd: number;
  total_discovered: number;
  in_progress: number;
  ready_for_approval: number;
  submitted: number;
  completed: number;
  last_scan?: string;
}

interface WorkspaceFiles {
  opp_id: string;
  workspace_path: string;
  files: Record<string, string>;
}

export const OpportunityPanel: React.FC = () => {
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [stats, setStats] = useState<Stats>({
    total_earnings_usd: 0,
    potential_pipeline_usd: 0,
    total_discovered: 0,
    in_progress: 0,
    ready_for_approval: 0,
    submitted: 0,
    completed: 0,
  });
  const [filter, setFilter] = useState<string>('all');
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  // Inspector Modal state
  const [inspectorOpen, setInspectorOpen] = useState<boolean>(false);
  const [activeWorkspace, setActiveWorkspace] = useState<WorkspaceFiles | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string>('');
  const [copied, setCopied] = useState<boolean>(false);

  const fetchOpportunities = async () => {
    if (window.electronAPI?.opportunityList) {
      try {
        const res = await window.electronAPI.opportunityList(filter === 'all' ? undefined : filter, 30);
        if (res && res.opportunities) {
          setOpportunities(res.opportunities);
        }
      } catch (e) {
        console.error('Failed to fetch opportunities:', e);
      }
    }
    if (window.electronAPI?.opportunityStats) {
      try {
        const res = await window.electronAPI.opportunityStats();
        if (res && res.stats) {
          setStats(res.stats);
        }
      } catch (e) {
        console.error('Failed to fetch opportunity stats:', e);
      }
    }
  };

  useEffect(() => {
    fetchOpportunities();
    const interval = setInterval(fetchOpportunities, 8000);
    return () => clearInterval(interval);
  }, [filter]);

  const handleScan = async () => {
    if (!window.electronAPI?.opportunityScan) return;
    setIsScanning(true);
    try {
      await window.electronAPI.opportunityScan();
      await fetchOpportunities();
    } catch (e) {
      console.error('Scan failed:', e);
    } finally {
      setIsScanning(false);
    }
  };

  const handlePrepareWorkspace = async (id: string) => {
    if (!window.electronAPI?.opportunityPrepare) return;
    setLoadingId(id);
    try {
      await window.electronAPI.opportunityPrepare(id);
      await fetchOpportunities();
    } catch (e) {
      console.error('Workspace setup failed:', e);
    } finally {
      setLoadingId(null);
    }
  };

  const handleOpenWorkspace = async (id: string, app: 'code' | 'folder' = 'code') => {
    if (!window.electronAPI?.opportunityOpenWorkspace) return;
    try {
      await window.electronAPI.opportunityOpenWorkspace(id, app);
    } catch (e) {
      console.error('Open workspace failed:', e);
    }
  };

  const handleViewWorkspace = async (id: string) => {
    if (!window.electronAPI?.opportunityGetWorkspace) return;
    setLoadingId(id);
    try {
      const res = await window.electronAPI.opportunityGetWorkspace(id);
      if (res && res.success) {
        setActiveWorkspace(res);
        const fileKeys = Object.keys(res.files || {});
        // Prefer PROPOSAL.md or solution_draft.py first
        const primary = fileKeys.find(k => k === 'PROPOSAL.md') || fileKeys.find(k => k.includes('solution')) || fileKeys[0] || '';
        setSelectedFileName(primary);
        setInspectorOpen(true);
      }
    } catch (e) {
      console.error('View workspace failed:', e);
    } finally {
      setLoadingId(null);
    }
  };

  const handleSolve = async (id: string) => {
    if (!window.electronAPI?.opportunitySolve) return;
    setLoadingId(id);
    try {
      await window.electronAPI.opportunitySolve(id);
      await fetchOpportunities();
      // Automatically open the inspector so user sees the solution immediately
      await handleViewWorkspace(id);
    } catch (e) {
      console.error('AI Solver failed:', e);
    } finally {
      setLoadingId(null);
    }
  };

  const handleApprove = async (id: string) => {
    if (!window.electronAPI?.opportunityApprove) return;
    setLoadingId(id);
    try {
      await window.electronAPI.opportunityApprove(id);
      await fetchOpportunities();
    } catch (e) {
      console.error('Approval failed:', e);
    } finally {
      setLoadingId(null);
    }
  };

  const copyCode = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex flex-col h-full gap-3 p-1 select-none overflow-hidden text-cyan-50 relative">
      {/* Top Stats Banner */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
        <div className="p-3 rounded-xl border border-cyan-500/30 bg-slate-950/70 flex flex-col justify-between">
          <span className="text-[10px] font-mono text-cyan-400/80 flex items-center gap-1.5">
            <DollarSign className="w-3.5 h-3.5 text-cyan-400" />
            POTENTIAL PIPELINE
          </span>
          <span className="text-xl font-black font-hud text-cyan-300 mt-1">
            ${stats.potential_pipeline_usd.toLocaleString(undefined, { minimumFractionDigits: 2 })}
          </span>
          <span className="text-[9px] text-slate-400 font-mono">Discovered via Bounties</span>
        </div>

        <div className="p-3 rounded-xl border border-cyan-500/30 bg-slate-950/70 flex flex-col justify-between">
          <span className="text-[10px] font-mono text-cyan-400/80 flex items-center gap-1.5">
            <TrendingUp className="w-3.5 h-3.5 text-cyan-400" />
            EARNED REVENUE
          </span>
          <span className="text-xl font-black font-hud text-emerald-400 mt-1">
            ${stats.total_earnings_usd.toLocaleString(undefined, { minimumFractionDigits: 2 })}
          </span>
          <span className="text-[9px] text-slate-400 font-mono">Completed Work</span>
        </div>

        <div className="p-3 rounded-xl border border-cyan-500/30 bg-slate-950/70 flex flex-col justify-between">
          <span className="text-[10px] font-mono text-cyan-400/80 flex items-center gap-1.5">
            <Briefcase className="w-3.5 h-3.5 text-cyan-400" />
            DISCOVERED TASKS
          </span>
          <span className="text-xl font-bold font-hud text-cyan-200 mt-1">
            {stats.total_discovered}
          </span>
          <span className="text-[9px] text-slate-400 font-mono">
            {stats.in_progress} in progress • {stats.ready_for_approval} pending approval
          </span>
        </div>

        <div className="p-3 rounded-xl border border-cyan-500/30 bg-slate-950/70 flex flex-col justify-between">
          <span className="text-[10px] font-mono text-cyan-400/80 flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
            AUTONOMY MODE
          </span>
          <span className="text-xs font-bold font-hud text-cyan-300 mt-1 uppercase tracking-wider">
            BALANCED MODE
          </span>
          <span className="text-[9px] text-slate-400 font-mono">Drafts in Sandbox • Sign-off Required</span>
        </div>
      </div>

      {/* Action & Filter Toolbar */}
      <div className="flex items-center justify-between gap-2 px-1">
        <div className="flex items-center gap-1.5 overflow-x-auto">
          {['all', 'discovered', 'in_progress', 'ready_for_approval', 'submitted', 'completed'].map((st) => (
            <button
              key={st}
              onClick={() => setFilter(st)}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-mono tracking-wider transition-all ${
                filter === st
                  ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-400/50 shadow-[0_0_10px_rgba(0,229,255,0.3)]'
                  : 'text-slate-400 hover:text-cyan-200 bg-slate-900/40 border border-transparent'
              }`}
            >
              {st.replace('_', ' ').toUpperCase()}
            </button>
          ))}
        </div>

        <button
          onClick={handleScan}
          disabled={isScanning}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/50 text-cyan-200 text-xs font-mono tracking-wider transition-all disabled:opacity-50 cursor-pointer"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isScanning ? 'animate-spin' : ''}`} />
          {isScanning ? 'SCANNING...' : 'SCAN BOUNTIES'}
        </button>
      </div>

      {/* Opportunity List */}
      <div className="flex-1 overflow-y-auto flex flex-col gap-2.5 pr-1">
        {opportunities.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 border border-dashed border-cyan-500/20 rounded-2xl text-slate-400 font-mono text-xs gap-2">
            <Briefcase className="w-8 h-8 text-cyan-500/40" />
            <span>No opportunities found for filter &quot;{filter}&quot;</span>
            <button
              onClick={handleScan}
              className="mt-2 text-cyan-300 underline hover:text-cyan-200 cursor-pointer"
            >
              Scan channels now
            </button>
          </div>
        ) : (
          opportunities.map((opp) => (
            <div
              key={opp.id}
              className="p-3.5 rounded-xl border border-cyan-500/25 bg-slate-950/60 hover:border-cyan-400/40 transition-all flex flex-col gap-2 shadow-[0_0_15px_rgba(0,229,255,0.05)]"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col gap-1 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded bg-cyan-950/80 border border-cyan-500/40 text-[9px] font-mono text-cyan-300">
                      {opp.source}
                    </span>
                    <span className="text-[10px] font-mono text-slate-400">
                      {opp.repo || 'Direct Task'}
                    </span>
                    {opp.feasibility_percent !== undefined && (
                      <span className="text-[10px] font-mono text-cyan-400">
                        {opp.feasibility_percent}% match
                      </span>
                    )}
                  </div>
                  <h4 className="text-sm font-bold text-cyan-100 line-clamp-1">{opp.title}</h4>
                </div>

                <div className="flex flex-col items-end flex-shrink-0">
                  <span className="text-base font-black font-hud text-cyan-300">
                    ${opp.reward_usd.toLocaleString()}
                  </span>
                  <span className={`text-[9px] font-mono uppercase px-1.5 py-0.5 rounded ${
                    opp.status === 'ready_for_approval' ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40' :
                    opp.status === 'in_progress' ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40' :
                    opp.status === 'submitted' ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40' :
                    'text-slate-400'
                  }`}>
                    {opp.status.replace('_', ' ')}
                  </span>
                </div>
              </div>

              {opp.approval_summary ? (
                <div className="p-2 rounded-lg bg-cyan-950/40 border border-cyan-500/20 text-xs text-cyan-200 font-mono">
                  <span className="text-cyan-400 font-bold">Solution Summary: </span>
                  {opp.approval_summary}
                </div>
              ) : (
                <p className="text-xs text-slate-300 line-clamp-2 font-mono leading-relaxed">
                  {opp.description}
                </p>
              )}

              {/* Matched Skills */}
              {opp.matched_skills && opp.matched_skills.length > 0 && (
                <div className="flex items-center gap-1.5 flex-wrap pt-1">
                  {opp.matched_skills.map((skill, idx) => (
                    <span
                      key={idx}
                      className="px-2 py-0.5 rounded bg-slate-900 border border-cyan-500/20 text-[10px] text-cyan-400 font-mono"
                    >
                      {skill}
                    </span>
                  ))}
                </div>
              )}

              {/* Actions Footer */}
              <div className="flex items-center justify-between pt-2 border-t border-cyan-500/15 text-xs font-mono flex-wrap gap-2">
                <a
                  href={opp.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-slate-400 hover:text-cyan-300 transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  View Original Task
                </a>

                <div className="flex items-center gap-1.5 flex-wrap">
                  {opp.status === 'discovered' && (
                    <button
                      onClick={() => handlePrepareWorkspace(opp.id)}
                      disabled={loadingId === opp.id}
                      className="flex items-center gap-1 px-3 py-1 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/40 text-cyan-300 transition-all cursor-pointer"
                    >
                      <Code2 className="w-3.5 h-3.5" />
                      {loadingId === opp.id ? 'PREPARING...' : 'SCAFFOLD & SOLVE'}
                    </button>
                  )}

                  {(opp.status === 'in_progress' || opp.status === 'ready_for_approval') && (
                    <>
                      {/* View Files in HUD */}
                      <button
                        onClick={() => handleViewWorkspace(opp.id)}
                        disabled={loadingId === opp.id}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-900/80 hover:bg-cyan-950/80 border border-cyan-500/30 text-cyan-300 transition-all cursor-pointer"
                        title="Inspect generated code and proposal directly in HUD"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        VIEW WORKSPACE
                      </button>

                      {/* Open in VS Code */}
                      <button
                        onClick={() => handleOpenWorkspace(opp.id, 'code')}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-900/80 hover:bg-cyan-950/80 border border-cyan-500/30 text-cyan-300 transition-all cursor-pointer"
                        title="Open folder in VS Code"
                      >
                        <Code2 className="w-3.5 h-3.5 text-blue-400" />
                        VS CODE
                      </button>

                      {/* Open Folder */}
                      <button
                        onClick={() => handleOpenWorkspace(opp.id, 'folder')}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-900/80 hover:bg-cyan-950/80 border border-cyan-500/30 text-slate-300 transition-all cursor-pointer"
                        title="Open folder in Files"
                      >
                        <FolderOpen className="w-3.5 h-3.5 text-amber-400" />
                        FOLDER
                      </button>

                      {/* Trigger AI Solver if in progress */}
                      {opp.status === 'in_progress' && (
                        <button
                          onClick={() => handleSolve(opp.id)}
                          disabled={loadingId === opp.id}
                          className="flex items-center gap-1 px-3 py-1 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/50 text-cyan-200 transition-all cursor-pointer shadow-[0_0_10px_rgba(0,229,255,0.2)]"
                        >
                          <Zap className="w-3.5 h-3.5 text-cyan-400" />
                          {loadingId === opp.id ? 'SOLVING WITH AGI...' : 'SOLVE WITH AGI'}
                          {loadingId === opp.id ? 'SOLVING WITH AI...' : 'SOLVE WITH AI'}
                        </button>
                      )}
                    </>
                  )}

                  {opp.status === 'ready_for_approval' && (
                    <button
                      onClick={() => handleApprove(opp.id)}
                      disabled={loadingId === opp.id}
                      className="flex items-center gap-1 px-3 py-1 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-400/50 text-emerald-300 font-bold transition-all cursor-pointer shadow-[0_0_12px_rgba(16,185,129,0.3)]"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      {loadingId === opp.id ? 'SUBMITTING...' : 'APPROVE & SUBMIT'}
                    </button>
                  )}

                  {opp.status === 'submitted' && (
                    <span className="flex items-center gap-1 text-emerald-300 text-[11px] px-2 py-0.5 rounded bg-emerald-950/40 border border-emerald-500/30">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      SUBMITTED FOR REVIEW
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* In-HUD Code & Workspace Inspector Modal */}
      {inspectorOpen && activeWorkspace && (
        <div className="absolute inset-0 bg-slate-950/90 backdrop-blur-md z-50 flex flex-col p-4 rounded-2xl border border-cyan-500/40 shadow-[0_0_40px_rgba(0,0,0,0.8)]">
          <div className="flex items-center justify-between pb-3 border-b border-cyan-500/25">
            <div className="flex items-center gap-2">
              <FileCode className="w-5 h-5 text-cyan-400" />
              <div>
                <h3 className="text-sm font-bold font-hud text-cyan-100">WORKSPACE INSPECTOR</h3>
                <p className="text-[10px] font-mono text-slate-400">{activeWorkspace.workspace_path}</p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => handleOpenWorkspace(activeWorkspace.opp_id, 'code')}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/40 text-cyan-300 text-xs font-mono cursor-pointer"
              >
                <Code2 className="w-3.5 h-3.5 text-blue-400" />
                OPEN IN VS CODE
              </button>

              <button
                onClick={() => setInspectorOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-cyan-200 hover:bg-slate-900 border border-transparent hover:border-cyan-500/30 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* File Tabs */}
          <div className="flex items-center gap-1.5 pt-3 pb-2 overflow-x-auto border-b border-cyan-500/15">
            {Object.keys(activeWorkspace.files || {}).map((fname) => (
              <button
                key={fname}
                onClick={() => setSelectedFileName(fname)}
                className={`px-3 py-1 rounded-lg text-xs font-mono transition-all cursor-pointer ${
                  selectedFileName === fname
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-400/50 shadow-[0_0_8px_rgba(0,229,255,0.3)]'
                    : 'text-slate-400 hover:text-cyan-200 bg-slate-900/40 border border-transparent'
                }`}
              >
                {fname}
              </button>
            ))}
          </div>

          {/* File Content Preview */}
          <div className="flex-1 overflow-y-auto mt-2 p-3 bg-slate-950/80 rounded-xl border border-cyan-500/20 font-mono text-xs text-slate-200 relative">
            <div className="absolute top-2 right-2 flex items-center gap-1 z-10">
              <button
                onClick={() => copyCode(activeWorkspace.files[selectedFileName] || '')}
                className="flex items-center gap-1 px-2 py-1 rounded bg-slate-900/90 border border-cyan-500/30 text-[10px] text-cyan-300 hover:bg-cyan-950 cursor-pointer"
              >
                {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                {copied ? 'COPIED' : 'COPY'}
              </button>
            </div>
            <pre className="whitespace-pre-wrap leading-relaxed">
              {activeWorkspace.files[selectedFileName] || '// Empty file or no content'}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
};
