import React, { useState } from 'react';
import { GitCommit, Copy, Check, ChevronDown, ChevronUp, FileCode } from 'lucide-react';

export interface GitDiffCardProps {
  filePath?: string;
  diff: string;
  additions?: number;
  deletions?: number;
}

export const GitDiffCard: React.FC<GitDiffCardProps> = ({
  filePath = 'modified_file',
  diff,
  additions,
  deletions,
}) => {
  const [copied, setCopied] = useState(false);
  const [isExpanded, setIsExpanded] = useState(true);

  const lines = diff.split('\n');

  // Compute additions/deletions if not explicitly provided
  const computedAdds = additions ?? lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
  const computedDels = deletions ?? lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;

  const handleCopy = () => {
    navigator.clipboard.writeText(diff);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="w-full my-3 rounded-2xl bg-gradient-to-br from-slate-950/95 via-slate-900/90 to-cyan-950/30 border border-cyan-500/35 shadow-[0_8px_32px_rgba(0,0,0,0.6)] overflow-hidden">
      {/* File Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-slate-950/90 border-b border-cyan-500/25">
        <div className="flex items-center gap-2 overflow-hidden">
          <FileCode className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
          <span className="text-[11px] font-mono text-cyan-200 font-bold truncate">
            {filePath}
          </span>
          <div className="flex items-center gap-1.5 ml-2 font-mono text-[10px]">
            <span className="text-emerald-400 bg-emerald-950/60 px-1.5 py-0.5 rounded border border-emerald-500/30">
              +{computedAdds}
            </span>
            <span className="text-rose-400 bg-rose-950/60 px-1.5 py-0.5 rounded border border-rose-500/30">
              -{computedDels}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={handleCopy}
            className="p-1 rounded-lg bg-cyan-950/40 border border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/20 transition-colors"
            title="Copy Diff Patch"
          >
            {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
          </button>
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-1 rounded-lg bg-cyan-950/40 border border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/20 transition-colors"
          >
            {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
        </div>
      </div>

      {/* Diff Stream */}
      {isExpanded && (
        <div className="p-2 overflow-x-auto font-mono text-[11px] leading-5 max-h-80 overflow-y-auto bg-black/60">
          {lines.map((line, idx) => {
            let lineClass = 'text-slate-400';
            let bgClass = '';

            if (line.startsWith('+') && !line.startsWith('+++')) {
              lineClass = 'text-emerald-300';
              bgClass = 'bg-emerald-950/40 border-l-2 border-emerald-500';
            } else if (line.startsWith('-') && !line.startsWith('---')) {
              lineClass = 'text-rose-300';
              bgClass = 'bg-rose-950/40 border-l-2 border-rose-500';
            } else if (line.startsWith('@@')) {
              lineClass = 'text-cyan-400 font-bold';
              bgClass = 'bg-cyan-950/30';
            }

            return (
              <div key={idx} className={`px-2 py-0.5 ${bgClass} whitespace-pre`}>
                <span className={lineClass}>{line}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
