import React, { useState, useMemo } from 'react';
import {
  BrainCircuit,
  Terminal,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ChevronDown,
  ChevronUp,
  Copy,
  Check,
  Sparkles,
  ExternalLink,
  Globe,
  Layers,
  Minimize2,
  Maximize2,
} from 'lucide-react';
import { ActivityStep, ToolCallStep } from '../types';
import { HudMarkdown } from './HudMarkdown';

interface ReasoningActionTraceProps {
  thinking?: string;
  toolCalls?: ToolCallStep[];
  activities?: ActivityStep[];
  isLive?: boolean;
  defaultExpanded?: boolean;
}

interface ParsedSearchResult {
  title: string;
  url: string;
  snippet: string;
  domain: string;
}

function extractDomain(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return url.slice(0, 30);
  }
}

function parseThoughtTrace(raw: string): {
  markdownText: string;
  searchResults: ParsedSearchResult[];
} {
  if (!raw) return { markdownText: '', searchResults: [] };

  let text = raw;

  // 1. Unescape outer JSON string if wrapped
  if (text.startsWith('"') && text.endsWith('"') && text.length > 2) {
    try {
      text = JSON.parse(text);
    } catch {
      text = text.slice(1, -1);
    }
  }

  // 2. Normalize literal backslash escapes
  if (text.includes('\\n') || text.includes('\\"') || text.includes('\\t') || text.includes('\\/')) {
    text = text
      .replace(/\\r\\n/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\t/g, '  ')
      .replace(/\\\//g, '/');
  }

  const searchResults: ParsedSearchResult[] = [];
  const seenUrls = new Set<string>();

  // 3. Try JSON.parse if the whole string is an array of objects
  const trimmed = text.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item && (item.title || item.url)) {
            const url = item.url || '';
            if (url && !seenUrls.has(url)) {
              seenUrls.add(url);
              searchResults.push({
                title: item.title || 'Untitled Source',
                url,
                snippet: item.snippet || item.body || item.content || '',
                domain: extractDomain(url),
              });
            }
          }
        }
        if (searchResults.length > 0) {
          return { markdownText: '', searchResults };
        }
      }
    } catch {}
  }

  // 4. Regex extraction for search result objects: { "title": "...", "url": "...", "snippet": "..." }
  const itemRegex = /\{\s*"title"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"url"\s*:\s*"((?:[^"\\]|\\.)*)"(?:\s*,\s*"snippet"\s*:\s*"((?:[^"\\]|\\.)*)")?\s*\}/g;
  let match;
  while ((match = itemRegex.exec(text)) !== null) {
    try {
      const title = match[1].replace(/\\"/g, '"').replace(/\\n/g, ' ').trim();
      const url = match[2].replace(/\\"/g, '"').trim();
      let snippet = (match[3] || '').replace(/\\"/g, '"').replace(/\\n/g, '\n').trim();
      if (url && !seenUrls.has(url)) {
        seenUrls.add(url);
        searchResults.push({
          title: title || 'Web Source Reference',
          url,
          snippet,
          domain: extractDomain(url),
        });
      }
    } catch {}
  }

  // 5. If search results were found, strip raw JSON from the markdown text
  let cleanText = text;
  if (searchResults.length > 0) {
    cleanText = cleanText.replace(itemRegex, '');
    cleanText = cleanText
      .replace(/\[\s*,\s*/g, '[')
      .replace(/,\s*\]/g, ']')
      .replace(/\[\s*\]/g, '')
      .replace(/^[,\s;{}\[\]]+|[,\s;{}\[\]]+$/g, '')
      .trim();
  }

  cleanText = cleanText.replace(/^[\s,;{}]+|[\s,;{}]+$/g, '').trim();

  return {
    markdownText: cleanText,
    searchResults,
  };
}

export const ReasoningActionTrace: React.FC<ReasoningActionTraceProps> = ({
  thinking,
  toolCalls = [],
  activities = [],
  isLive = false,
  defaultExpanded,
}) => {
  const [isExpanded, setIsExpanded] = useState<boolean>(
    defaultExpanded !== undefined ? defaultExpanded : isLive
  );
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'all' | 'thoughts' | 'actions'>('all');
  const [expandedDetails, setExpandedDetails] = useState<Record<string, boolean>>({});

  // Merge steps into chronological sequence
  const displayActivities: ActivityStep[] = useMemo(() => {
    if (activities && activities.length > 0) {
      return activities;
    }
    const steps: ActivityStep[] = [];
    if (thinking) {
      steps.push({
        id: 'thinking_main',
        type: 'thinking',
        title: 'Cognitive Reasoning Trace',
        content: thinking,
        status: isLive ? 'running' : 'completed',
        timestamp: Date.now(),
      });
    }
    if (toolCalls && toolCalls.length > 0) {
      toolCalls.forEach((t, idx) => {
        steps.push({
          id: t.id || `tool_${idx}`,
          type: 'action',
          title: `Action: ${t.name}`,
          status: t.status,
          toolCall: t,
          timestamp: t.startedAt || Date.now(),
          durationMs: t.durationMs,
        });
      });
    }
    return steps;
  }, [activities, thinking, toolCalls, isLive]);

  const thoughtSteps = useMemo(
    () => displayActivities.filter((a) => a.type === 'thinking'),
    [displayActivities]
  );
  const actionSteps = useMemo(
    () => displayActivities.filter((a) => a.type === 'action'),
    [displayActivities]
  );

  const filteredSteps = useMemo(() => {
    if (activeTab === 'thoughts') return thoughtSteps;
    if (activeTab === 'actions') return actionSteps;
    return displayActivities;
  }, [activeTab, displayActivities, thoughtSteps, actionSteps]);

  if (displayActivities.length === 0 && !thinking && (!toolCalls || toolCalls.length === 0)) {
    return null;
  }

  const handleCopy = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const toggleDetail = (id: string) => {
    setExpandedDetails((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const totalWords = thinking
    ? thinking.trim().split(/\s+/).length
    : thoughtSteps.reduce((acc, t) => acc + (t.content ? t.content.trim().split(/\s+/).length : 0), 0);
  const toolCount = actionSteps.length > 0 ? actionSteps.length : toolCalls.length;
  const runningTool = displayActivities.find((a) => a.type === 'action' && a.status === 'running');

  return (
    <div className="w-full my-2 select-text font-sans">
      {/* Outer Container with Cyberpunk Glassmorphism */}
      <div
        className={`rounded-2xl transition-all duration-300 border overflow-hidden ${
          isLive
            ? 'bg-gradient-to-b from-purple-950/40 via-slate-950/80 to-cyan-950/40 border-cyan-400/60 shadow-[0_0_30px_rgba(0,229,255,0.2)]'
            : 'bg-slate-950/70 border-cyan-500/30 shadow-[0_6px_25px_rgba(0,0,0,0.5)] backdrop-blur-md'
        }`}
      >
        {/* Header Bar / Summary Pill */}
        <div
          onClick={() => setIsExpanded(!isExpanded)}
          className="px-3.5 py-2.5 flex items-center justify-between cursor-pointer hover:bg-white/[0.04] transition-colors border-b border-cyan-500/20"
        >
          <div className="flex items-center gap-2 flex-wrap text-xs">
            {/* Live pulsating or completed icon */}
            {isLive ? (
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-cyan-500/20 border border-cyan-400/70 text-cyan-300 shadow-[0_0_12px_rgba(0,229,255,0.4)]">
                <Sparkles className="w-3.5 h-3.5 text-cyan-300 animate-spin" />
                <span className="text-[10px] font-hud tracking-wider uppercase font-bold">
                  {runningTool ? `EXECUTING: ${runningTool.toolCall?.name || 'TOOL'}` : 'NEURAL REASONING ACTIVE'}
                </span>
                <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-ping" />
              </div>
            ) : (
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-cyan-950/60 border border-cyan-500/40 text-cyan-300 shadow-[0_0_8px_rgba(0,229,255,0.15)]">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                <span className="text-[10px] font-hud tracking-wider uppercase font-bold text-cyan-200">
                  Cognition & Action Trace
                </span>
              </div>
            )}

            {/* Badges for counts */}
            {totalWords > 0 && (
              <div className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-purple-950/50 border border-purple-500/40 text-purple-300 text-[10px] font-mono">
                <BrainCircuit className="w-3 h-3 text-purple-400" />
                <span>{totalWords} cognitive tokens</span>
              </div>
            )}

            {toolCount > 0 && (
              <div className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-cyan-950/50 border border-cyan-500/40 text-cyan-300 text-[10px] font-mono">
                <Terminal className="w-3 h-3 text-cyan-400" />
                <span>{toolCount} action{toolCount > 1 ? 's' : ''} executed</span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              className="flex items-center gap-1 text-[11px] font-hud tracking-wider text-cyan-400 hover:text-cyan-200 uppercase font-bold"
            >
              <span>{isExpanded ? 'Collapse' : 'Inspect Trace'}</span>
              {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>

        {/* Expanded Body */}
        {isExpanded && (
          <div className="p-3 space-y-3">
            {/* Filter Tabs if multiple types exist */}
            {(thoughtSteps.length > 0 && actionSteps.length > 0) && (
              <div className="flex items-center gap-1.5 pb-2 border-b border-cyan-500/15">
                <button
                  type="button"
                  onClick={() => setActiveTab('all')}
                  className={`px-2.5 py-1 rounded-lg text-[10px] font-hud uppercase tracking-wider flex items-center gap-1 cursor-pointer transition-all ${
                    activeTab === 'all'
                      ? 'bg-cyan-500/20 text-cyan-200 border border-cyan-400/50 shadow-[0_0_8px_rgba(0,229,255,0.2)]'
                      : 'text-slate-400 hover:text-slate-200 bg-white/[0.02]'
                  }`}
                >
                  <Layers className="w-3 h-3" />
                  All Steps ({displayActivities.length})
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('thoughts')}
                  className={`px-2.5 py-1 rounded-lg text-[10px] font-hud uppercase tracking-wider flex items-center gap-1 cursor-pointer transition-all ${
                    activeTab === 'thoughts'
                      ? 'bg-purple-500/20 text-purple-200 border border-purple-400/50 shadow-[0_0_8px_rgba(168,85,247,0.2)]'
                      : 'text-slate-400 hover:text-purple-300 bg-white/[0.02]'
                  }`}
                >
                  <BrainCircuit className="w-3 h-3" />
                  Cognitive Thoughts ({thoughtSteps.length})
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('actions')}
                  className={`px-2.5 py-1 rounded-lg text-[10px] font-hud uppercase tracking-wider flex items-center gap-1 cursor-pointer transition-all ${
                    activeTab === 'actions'
                      ? 'bg-cyan-500/20 text-cyan-200 border border-cyan-400/50 shadow-[0_0_8px_rgba(0,229,255,0.2)]'
                      : 'text-slate-400 hover:text-cyan-300 bg-white/[0.02]'
                  }`}
                >
                  <Terminal className="w-3 h-3" />
                  Tool Actions ({actionSteps.length})
                </button>
              </div>
            )}

            {/* List of Steps with smooth scrolling */}
            <div className="space-y-3 max-h-[520px] overflow-y-auto hud-scroll pr-1">
              {filteredSteps.map((step, idx) => {
                if (step.type === 'thinking') {
                  const { markdownText, searchResults } = parseThoughtTrace(step.content || '');

                  return (
                    <div
                      key={step.id || `think_${idx}`}
                      className="rounded-xl bg-gradient-to-br from-purple-950/25 via-slate-950/90 to-purple-950/15 border border-purple-500/35 shadow-[inset_0_0_20px_rgba(168,85,247,0.08),0_4px_16px_rgba(0,0,0,0.4)] overflow-hidden"
                    >
                      {/* Thought Card Header */}
                      <div className="px-3.5 py-2 flex items-center justify-between bg-purple-950/40 border-b border-purple-500/25 text-purple-200">
                        <div className="flex items-center gap-2">
                          <div className="p-1 rounded-md bg-purple-500/25 text-purple-300 shadow-[0_0_8px_rgba(168,85,247,0.4)]">
                            <BrainCircuit className="w-3.5 h-3.5" />
                          </div>
                          <span className="font-hud font-bold text-xs uppercase tracking-wider text-purple-200">
                            Neural Synthesis & Cognitive Stream
                          </span>
                          {isLive && step.status === 'running' && (
                            <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-purple-500/20 border border-purple-400/50 text-[9px] text-purple-300 font-mono animate-pulse">
                              STREAMING
                            </span>
                          )}
                        </div>

                        {step.content && (
                          <button
                            type="button"
                            onClick={() => handleCopy(step.id, step.content || '')}
                            title="Copy thoughts"
                            className="text-[10px] text-purple-400 hover:text-purple-200 flex items-center gap-1 cursor-pointer font-mono transition-colors"
                          >
                            {copiedId === step.id ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                            <span>{copiedId === step.id ? 'Copied' : 'Copy'}</span>
                          </button>
                        )}
                      </div>

                      <div className="p-3.5 space-y-3">
                        {/* Render Sourced Web Intelligence References if extracted */}
                        {searchResults.length > 0 && (
                          <div className="space-y-2">
                            <div className="flex items-center gap-1.5 text-[10px] font-hud uppercase tracking-wider text-cyan-300 font-bold">
                              <Globe className="w-3.5 h-3.5 text-cyan-400 animate-pulse" />
                              <span>Sourced Web Intelligence Citations ({searchResults.length})</span>
                            </div>

                            <div className="grid grid-cols-1 gap-2">
                              {searchResults.map((src, sIdx) => (
                                <div
                                  key={sIdx}
                                  className="p-2.5 rounded-xl bg-slate-900/90 border border-cyan-500/30 hover:border-cyan-400/60 transition-all group shadow-[0_2px_10px_rgba(0,0,0,0.3)]"
                                >
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      <span className="px-1.5 py-0.5 rounded bg-cyan-950/80 border border-cyan-500/40 text-[9px] font-mono text-cyan-300 font-bold">
                                        {src.domain}
                                      </span>
                                      <h4 className="text-xs font-bold text-slate-100 group-hover:text-cyan-300 transition-colors">
                                        {src.title}
                                      </h4>
                                    </div>

                                    {src.url && (
                                      <a
                                        href={src.url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="p-1 rounded-lg text-slate-400 hover:text-cyan-300 hover:bg-cyan-500/20 transition-colors shrink-0"
                                        title="Open source link"
                                      >
                                        <ExternalLink className="w-3.5 h-3.5" />
                                      </a>
                                    )}
                                  </div>

                                  {src.snippet && (
                                    <p className="mt-1.5 text-[11px] leading-relaxed text-slate-300 select-text font-sans">
                                      {src.snippet}
                                    </p>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Render Cognitive Markdown Thoughts */}
                        {markdownText ? (
                          <div className="text-xs leading-relaxed text-purple-100/90 select-text font-sans">
                            <HudMarkdown content={markdownText} />
                          </div>
                        ) : searchResults.length === 0 ? (
                          <div className="text-[11px] leading-relaxed text-purple-200/90 whitespace-pre-wrap select-text font-mono">
                            {step.content}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );
                }

                // Tool / Action Step
                const t = step.toolCall;
                const toolName = t?.name || 'tool';
                const isToolRunning = step.status === 'running' || t?.status === 'running';
                const isToolError = step.status === 'error' || t?.status === 'error' || t?.isError;
                const hasOutput = Boolean(t?.result);
                const isDetailsOpen = expandedDetails[step.id] ?? true;

                // Format Command/Input for clean display
                let commandDisplay = '';
                if (t?.input) {
                  if (typeof t.input === 'string') {
                    commandDisplay = t.input;
                  } else if (t.input.command) {
                    commandDisplay = t.input.command;
                  } else if (t.input.query) {
                    commandDisplay = `query: "${t.input.query}"`;
                  } else if (t.input.path || t.input.file) {
                    commandDisplay = `path: ${t.input.path || t.input.file}`;
                  } else if (t.input.url) {
                    commandDisplay = `url: ${t.input.url}`;
                  } else {
                    commandDisplay = JSON.stringify(t.input);
                  }
                }

                return (
                  <div
                    key={step.id || `action_${idx}`}
                    className="rounded-xl bg-slate-950/80 border border-cyan-500/25 overflow-hidden shadow-[0_4px_16px_rgba(0,0,0,0.3)]"
                  >
                    {/* Action Header */}
                    <div
                      onClick={() => toggleDetail(step.id)}
                      className="px-3 py-2 flex items-center justify-between bg-cyan-950/30 hover:bg-cyan-950/50 cursor-pointer border-b border-cyan-500/20"
                    >
                      <div className="flex items-center gap-2 overflow-hidden">
                        <div className="p-1 rounded-md bg-cyan-500/20 text-cyan-300">
                          <Terminal className="w-3 h-3" />
                        </div>
                        <span className="font-bold text-xs uppercase tracking-wider text-cyan-300 font-hud">
                          {toolName}
                        </span>
                        {commandDisplay && (
                          <span className="text-[10px] text-slate-400 truncate max-w-xs md:max-w-md font-mono">
                            {commandDisplay}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-2">
                        {t?.durationMs ? (
                          <span className="text-[9px] text-slate-500 font-mono">
                            {t.durationMs}ms
                          </span>
                        ) : null}

                        {isToolRunning ? (
                          <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/20 border border-amber-400/50 text-amber-300 text-[9px] font-bold uppercase tracking-wider font-hud">
                            <Loader2 className="w-2.5 h-2.5 animate-spin" /> RUNNING
                          </span>
                        ) : isToolError ? (
                          <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-rose-500/20 border border-rose-400/50 text-rose-300 text-[9px] font-bold uppercase tracking-wider font-hud">
                            <AlertCircle className="w-2.5 h-2.5" /> ERROR
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/20 border border-emerald-400/50 text-emerald-300 text-[9px] font-bold uppercase tracking-wider font-hud">
                            <CheckCircle2 className="w-2.5 h-2.5" /> SUCCESS
                          </span>
                        )}

                        <button type="button" className="text-slate-400 hover:text-cyan-300">
                          {isDetailsOpen ? <Minimize2 className="w-3 h-3" /> : <Maximize2 className="w-3 h-3" />}
                        </button>
                      </div>
                    </div>

                    {/* Action Content Details */}
                    {isDetailsOpen && (
                      <div className="p-3 space-y-2.5 text-[10px]">
                        {/* Command / Input preview */}
                        {commandDisplay && (
                          <div className="space-y-1">
                            <div className="flex items-center justify-between text-slate-400 text-[9px] font-mono">
                              <span>INPUT COMMAND / ARGS:</span>
                              <button
                                type="button"
                                onClick={() => handleCopy(`cmd_${step.id}`, commandDisplay)}
                                className="text-cyan-400 hover:text-cyan-200 flex items-center gap-1 cursor-pointer"
                              >
                                {copiedId === `cmd_${step.id}` ? <Check className="w-2.5 h-2.5 text-emerald-400" /> : <Copy className="w-2.5 h-2.5" />}
                                <span>{copiedId === `cmd_${step.id}` ? 'Copied' : 'Copy'}</span>
                              </button>
                            </div>
                            <div className="p-2 rounded-lg bg-black/70 border border-slate-800 text-cyan-300 font-mono whitespace-pre-wrap select-text break-all">
                              {commandDisplay}
                            </div>
                          </div>
                        )}

                        {/* Tool Output Result */}
                        {hasOutput && (
                          <div className="space-y-1">
                            <div className="flex items-center justify-between text-slate-400 text-[9px] font-mono">
                              <span className={isToolError ? 'text-rose-400 font-bold' : 'text-emerald-400 font-bold'}>
                                {isToolError ? 'ERROR OUTPUT:' : 'EXECUTION OUTPUT (STDOUT):'}
                              </span>
                              <button
                                type="button"
                                onClick={() => handleCopy(`out_${step.id}`, t?.result || '')}
                                className="text-cyan-400 hover:text-cyan-200 flex items-center gap-1 cursor-pointer"
                              >
                                {copiedId === `out_${step.id}` ? <Check className="w-2.5 h-2.5 text-emerald-400" /> : <Copy className="w-2.5 h-2.5" />}
                                <span>{copiedId === `out_${step.id}` ? 'Copied' : 'Copy'}</span>
                              </button>
                            </div>
                            <div className="p-2.5 rounded-lg bg-black/90 border border-cyan-500/20 text-slate-200 font-mono whitespace-pre-wrap select-text max-h-56 overflow-y-auto hud-scroll text-[10px] leading-relaxed">
                              {t?.result}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
