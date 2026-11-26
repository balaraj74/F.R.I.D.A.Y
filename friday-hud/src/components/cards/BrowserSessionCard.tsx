import React, { useState } from 'react';
import { Globe, ExternalLink, Copy, Check, Eye, RefreshCw, ShieldCheck } from 'lucide-react';

export interface BrowserSessionCardProps {
  url: string;
  title?: string;
  screenshotUrl?: string;
  contentSnippet?: string;
  profileId?: string;
  status?: 'active' | 'loading' | 'completed' | 'error';
  onRefresh?: () => void;
  onOpenExternal?: () => void;
}

export const BrowserSessionCard: React.FC<BrowserSessionCardProps> = ({
  url,
  title = 'Web Page Session',
  screenshotUrl,
  contentSnippet,
  profileId = 'default',
  status = 'completed',
  onRefresh,
  onOpenExternal,
}) => {
  const [copied, setCopied] = useState(false);
  const [showFullPreview, setShowFullPreview] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="w-full my-3 rounded-2xl bg-gradient-to-br from-slate-950/90 via-slate-900/90 to-cyan-950/40 border border-cyan-500/40 shadow-[0_8px_32px_rgba(0,0,0,0.6),0_0_20px_rgba(0,229,255,0.12)] overflow-hidden transition-all duration-200">
      {/* Top Browser Title Bar */}
      <div className="flex items-center justify-between px-3 py-2 bg-slate-950/80 border-b border-cyan-500/20">
        <div className="flex items-center gap-2 overflow-hidden">
          {/* Traffic lights */}
          <div className="flex items-center gap-1.5 mr-1">
            <span className="w-2.5 h-2.5 rounded-full bg-red-500/80 shadow-[0_0_6px_rgba(239,68,68,0.6)]" />
            <span className="w-2.5 h-2.5 rounded-full bg-yellow-500/80 shadow-[0_0_6px_rgba(245,158,11,0.6)]" />
            <span className="w-2.5 h-2.5 rounded-full bg-green-500/80 shadow-[0_0_6px_rgba(34,197,94,0.6)]" />
          </div>

          <Globe className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
          <span className="text-[11px] font-mono text-cyan-200 truncate font-semibold">
            {title}
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[9px] font-mono px-2 py-0.5 rounded-md bg-cyan-950/80 border border-cyan-500/30 text-cyan-300 flex items-center gap-1">
            <ShieldCheck className="w-2.5 h-2.5 text-cyan-400" />
            profile:{profileId}
          </span>
          {onRefresh && (
            <button
              onClick={onRefresh}
              className="p-1 rounded text-slate-400 hover:text-cyan-300 transition-colors"
              title="Refresh page"
            >
              <RefreshCw className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      {/* URL Address Bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-900/60 border-b border-cyan-500/15">
        <div className="flex-1 flex items-center gap-1.5 bg-slate-950/80 px-2.5 py-1 rounded-lg border border-cyan-500/20 overflow-hidden font-mono text-[10px] text-slate-300">
          <span className="text-cyan-400 font-bold select-none">URL:</span>
          <span className="truncate select-all">{url}</span>
        </div>

        <button
          onClick={handleCopy}
          className="p-1 rounded-lg bg-cyan-950/40 border border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/20 transition-colors"
          title="Copy URL"
        >
          {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
        </button>

        {onOpenExternal && (
          <button
            onClick={onOpenExternal}
            className="p-1 rounded-lg bg-cyan-950/40 border border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/20 transition-colors"
            title="Open in System Browser"
          >
            <ExternalLink className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* Screenshot or Content Preview */}
      <div className="p-3">
        {screenshotUrl ? (
          <div className="relative rounded-xl overflow-hidden border border-cyan-500/30 group">
            <img
              src={screenshotUrl}
              alt={title}
              className={`w-full object-cover transition-all ${
                showFullPreview ? 'max-h-none' : 'max-h-48'
              }`}
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-2 justify-end">
              <button
                onClick={() => setShowFullPreview(!showFullPreview)}
                className="px-2 py-1 rounded bg-slate-950/90 border border-cyan-400 text-cyan-300 text-[10px] font-mono flex items-center gap-1"
              >
                <Eye className="w-3 h-3" />
                {showFullPreview ? 'Collapse' : 'Expand View'}
              </button>
            </div>
          </div>
        ) : contentSnippet ? (
          <div className="p-2.5 rounded-xl bg-slate-950/70 border border-cyan-500/20 font-mono text-[11px] text-slate-300 leading-relaxed max-h-36 overflow-y-auto">
            {contentSnippet}
          </div>
        ) : null}
      </div>
    </div>
  );
};
