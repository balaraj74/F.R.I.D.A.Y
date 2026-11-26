import React, { useState, useEffect, useRef, useMemo } from 'react';
import { fridayLabel, useFridayInfo } from '../services/friday-info';
import {
  Send,
  Bot,
  User,
  RefreshCw,
  StopCircle,
  History,
  Plus,
  MessageSquare,
  ChevronDown,
  Search,
  Clock,
  Sparkles,
  X,
  Radio,
  ExternalLink,
} from 'lucide-react';
import { ChatMessage, ActivityStep, SessionItem } from '../types';
import { gateway } from '../services/gateway-ws';
import { WorkTrace } from './WorkTrace';
import { JobCards } from './JobCards';
import { WorkingCard } from './WorkingCard';
import { useProjects } from '../services/projects';
import { cleanSessionTitle } from '../services/session-title';
import { HudMarkdown } from './HudMarkdown';
import { ErrorBoundary } from './ErrorBoundary';
import { useStickToBottom } from '../services/use-stick-bottom';

interface ChatPanelProps {
  messages: ChatMessage[];
  onSendMessage: (text: string) => void;
  isThinking?: boolean;
  thinkingContent?: string;
  liveActivities?: ActivityStep[];
  onRefreshHistory?: () => void;
  currentSessionKey?: string;
  sessions?: SessionItem[];
  onSelectSession?: (key: string) => void;
  onNewSession?: () => void;
}

export const ChatPanel: React.FC<ChatPanelProps> = ({
  messages,
  onSendMessage,
  isThinking = false,
  thinkingContent = '',
  liveActivities = [],
  onRefreshHistory,
  currentSessionKey = 'agent:main:main',
  sessions = [],
  onSelectSession,
  onNewSession,
}) => {
  const fridayInfo = useFridayInfo();
  const { active: activeProject } = useProjects();
  const [input, setInput] = useState('');
  const [isSessionModalOpen, setIsSessionModalOpen] = useState(false);
  const [sessionSearch, setSessionSearch] = useState('');
  const { containerRef, onScroll } = useStickToBottom(messages[messages.length - 1]?.role, [
    messages,
    isThinking,
    thinkingContent,
    liveActivities,
  ]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    onSendMessage(input.trim());
    setInput('');
  };

  const handleAbort = async () => {
    try {
      await gateway.abortChat(currentSessionKey);
    } catch (e) {
      console.warn('Abort error:', e);
    }
  };

  const activeSession = useMemo(() => {
    return sessions.find((s) => s.key === currentSessionKey);
  }, [sessions, currentSessionKey]);

  const filteredSessions = useMemo(() => {
    if (!sessionSearch.trim()) return sessions;
    const q = sessionSearch.toLowerCase();
    return sessions.filter((s) => {
      const matchTitle = (s.derivedTitle || s.label || s.displayName || s.key).toLowerCase().includes(q);
      const matchSnippet = (s.lastMessagePreview || '').toLowerCase().includes(q);
      const matchChannel = (s.channel || '').toLowerCase().includes(q);
      return matchTitle || matchSnippet || matchChannel;
    });
  }, [sessions, sessionSearch]);

  const formatRelativeTime = (ts?: number) => {
    if (!ts) return 'Earlier';
    const diffSec = Math.floor((Date.now() - ts) / 1000);
    if (diffSec < 60) return 'Just now';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

  return (
    <div className="flex-1 flex flex-col p-4 overflow-hidden space-y-3 relative">
      {/* Header Bar */}
      <div className="flex items-center justify-between pb-3 border-b border-cyan-500/20 flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-cyan-500/20 border border-cyan-400 text-cyan-300 shadow-[0_0_12px_#00e5ff]">
            <Bot className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold font-hud tracking-wider text-cyan-300 flex items-center gap-2">
                CONVERSATIONS
                <span className="w-2 h-2 rounded-full bg-cyan-400 animate-ping" />
              </h2>

              {/* Current Session Chip / Revisit Selector Trigger */}
              <button
                type="button"
                onClick={() => setIsSessionModalOpen(true)}
                className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-cyan-950/70 border border-cyan-400/50 hover:border-cyan-300 text-cyan-200 text-[11px] font-mono shadow-[0_0_8px_rgba(0,229,255,0.2)] cursor-pointer transition-all max-w-[240px] truncate"
                title="Click to revisit previous chats"
              >
                <MessageSquare className="w-3 h-3 text-cyan-400 shrink-0" />
                <span className="truncate">
                  {cleanSessionTitle(activeSession?.derivedTitle || activeSession?.label) || (currentSessionKey === 'agent:main:main' ? 'Main Session' : currentSessionKey.replace('agent:main:', ''))}
                </span>
                <ChevronDown className="w-3 h-3 text-cyan-400 shrink-0" />
              </button>
            </div>

            <p className="text-xs font-mono text-cyan-400/90 font-bold flex items-center gap-2 mt-0.5">
              <span>{fridayLabel(fridayInfo)}</span>
              {activeSession?.channel && (
                <span className="px-1.5 py-0.2 rounded bg-slate-900 border border-cyan-500/30 text-[10px] text-cyan-300 uppercase">
                  {activeSession.channel}
                </span>
              )}
            </p>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2">
          {/* New Chat Button */}
          {onNewSession && (
            <button
              onClick={onNewSession}
              className="px-3 py-1.5 rounded-xl border border-cyan-400/60 bg-gradient-to-r from-cyan-500/20 to-blue-500/20 hover:from-cyan-500/30 hover:to-blue-500/30 text-cyan-200 text-xs font-hud font-bold uppercase tracking-wider flex items-center gap-1.5 cursor-pointer shadow-[0_0_12px_rgba(0,229,255,0.2)] transition-all"
              title="Start a fresh conversation session"
            >
              <Plus className="w-3.5 h-3.5 text-cyan-300" />
              <span>New Chat</span>
            </button>
          )}

          {/* Revisit Past Chats Button */}
          <button
            onClick={() => setIsSessionModalOpen(true)}
            className="px-3 py-1.5 rounded-xl border border-cyan-500/40 bg-slate-900/80 hover:bg-cyan-950/50 text-cyan-300 text-xs font-hud font-bold uppercase tracking-wider flex items-center gap-1.5 cursor-pointer transition-colors"
            title="Browse and revisit past conversations"
          >
            <History className="w-3.5 h-3.5 text-cyan-400" />
            <span>Chats ({sessions.length})</span>
          </button>

          {isThinking && (
            <button
              onClick={handleAbort}
              className="px-3 py-1.5 rounded-xl border border-red-500/50 bg-red-500/20 hover:bg-red-500/30 text-red-300 text-xs font-mono flex items-center gap-1.5 cursor-pointer"
            >
              <StopCircle className="w-3.5 h-3.5" /> ABORT
            </button>
          )}

          {onRefreshHistory && (
            <button
              onClick={onRefreshHistory}
              className="p-1.5 rounded-xl border border-cyan-500/40 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-300 text-xs font-mono flex items-center gap-1.5 cursor-pointer"
              title="Refresh History"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Background jobs in progress */}
      <JobCards />

      {/* Messages Stream */}
      <div
        ref={containerRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto p-4 rounded-2xl hud-glass-panel border border-cyan-500/30 space-y-4"
      >
        {messages.map((m) => (
          <ErrorBoundary key={m.id} compact>
          {m.role === 'system' ? (
            <div key={m.id} className="flex items-center gap-3 w-full py-1 text-[10px] font-mono text-slate-500" role="note">
              <span className="flex-1 h-px bg-slate-700/60" />
              <span>
                {m.text} · {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
              <span className="flex-1 h-px bg-slate-700/60" />
            </div>
          ) : (
          <div
            key={m.id}
            className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'} w-full`}
          >
            <div className="flex items-center gap-2 mb-1">
              {m.role === 'user' ? (
                <>
                  <span className="text-[10px] font-mono text-slate-400">Balaraj</span>
                  <User className="w-3.5 h-3.5 text-cyan-400" />
                </>
              ) : (
                <>
                  <Bot className="w-3.5 h-3.5 text-cyan-400" />
                  <span className="text-[10px] font-mono text-cyan-300 font-bold">FRIDAY 🦾</span>
                </>
              )}
              <span className="text-[9px] font-mono text-slate-500">
                {new Date(m.timestamp).toLocaleTimeString()}
              </span>
            </div>

            {/* Cognitive & Action Trace (Thinking + Tool Calls) */}
            {m.role === 'assistant' && (m.thinking || (m.toolCalls && m.toolCalls.length > 0) || (m.activities && m.activities.length > 0)) && (
              <div className="max-w-[85%] w-full">
                <WorkTrace
                  thinking={m.thinking}
                  toolCalls={m.toolCalls}
                  activities={m.activities}
                  isLive={false}
                />
              </div>
            )}

            {/* Message Bubble (if text exists) */}
            {m.text && (
              <div
                className={`max-w-[85%] select-text ${m.role === 'user' ? 'sk-bubble-user' : 'sk-bubble-friday'}`}
              >
                <HudMarkdown content={m.text} isUser={m.role === 'user'} onChoose={onSendMessage} />
              </div>
            )}
          </div>
          )}
          </ErrorBoundary>
        ))}

        {/* Live Thinking & Acting Trace */}
        {isThinking && (
          <ErrorBoundary compact label="Live progress could not be shown">
            <WorkingCard thinking={thinkingContent} activities={liveActivities} />
          </ErrorBoundary>
        )}
      </div>

      {/* Suggested Prompts & Input Form */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          {[
            'Check WhatsApp messages',
            'Run system diagnostic',
            'List active cron jobs',
            activeProject ? `Show ${activeProject.name} project state` : 'Show my active project state',
            'Review memory flags',
          ].map((prompt, idx) => (
            <button
              key={idx}
              onClick={() => onSendMessage(`FRIDAY, ${prompt.toLowerCase()}`)}
              className="px-2.5 py-1 rounded-lg text-[10px] font-hud hud-glass-pill text-cyan-300 hover:text-cyan-100 whitespace-nowrap cursor-pointer transition-colors"
            >
              {prompt}
            </button>
          ))}
        </div>

        <form onSubmit={handleSubmit} className="sk-console-foot !m-0">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={isThinking ? 'Message FRIDAY… (she is working; this will queue)' : 'Message FRIDAY…'}
            className="sk-input flex-1"
          />
          <button
            type="submit"
            disabled={!input.trim()}
            title="Send"
            aria-label="Send"
            className="sk-send"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
      </div>

      {/* Session Revisit Modal / Archive Flyout */}
      {isSessionModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-md animate-fade-in">
          <div className="w-full max-w-2xl max-h-[85vh] rounded-2xl bg-slate-950/95 border border-cyan-400/50 shadow-[0_0_40px_rgba(0,229,255,0.25)] flex flex-col overflow-hidden">
            {/* Modal Header */}
            <div className="p-4 border-b border-cyan-500/25 flex items-center justify-between bg-cyan-950/30">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-xl bg-cyan-500/20 border border-cyan-400 text-cyan-300">
                  <History className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-hud font-bold text-sm tracking-wider uppercase text-cyan-200 flex items-center gap-2">
                    CONVERSATION ARCHIVE & REVISIT
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-950 border border-cyan-500/40 text-cyan-300">
                      {sessions.length} sessions
                    </span>
                  </h3>
                  <p className="text-[11px] font-mono text-slate-400">
                    Select any past session to review reasoning traces, actions, and resume conversation
                  </p>
                </div>
              </div>

              <button
                onClick={() => setIsSessionModalOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-cyan-300 hover:bg-cyan-500/20 transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Search & Actions Bar */}
            <div className="p-3 border-b border-cyan-500/20 flex items-center gap-2 bg-slate-900/50">
              <div className="flex-1 relative">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={sessionSearch}
                  onChange={(e) => setSessionSearch(e.target.value)}
                  placeholder="Search previous chats by title, prompt, or channel..."
                  className="w-full bg-slate-950 border border-cyan-500/30 rounded-xl pl-9 pr-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-cyan-400 font-mono"
                />
              </div>

              {onNewSession && (
                <button
                  onClick={() => {
                    onNewSession();
                    setIsSessionModalOpen(false);
                  }}
                  className="px-3 py-2 rounded-xl bg-gradient-to-r from-cyan-400 to-cyan-300 text-slate-950 font-hud font-bold text-xs uppercase tracking-wider flex items-center gap-1.5 cursor-pointer shrink-0 shadow-[0_0_12px_rgba(0,229,255,0.4)]"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Start Fresh Chat</span>
                </button>
              )}
            </div>

            {/* Sessions List */}
            <div className="flex-1 overflow-y-auto p-3 space-y-2.5 hud-scroll">
              {filteredSessions.length === 0 ? (
                <div className="text-center py-12 text-slate-500 font-mono text-xs">
                  No conversations match your search query.
                </div>
              ) : (
                filteredSessions.map((s) => {
                  const isCurrent = s.key === currentSessionKey;
                  const title = cleanSessionTitle(s.derivedTitle || s.label || s.displayName) || s.key;
                  const preview = s.lastMessagePreview;

                  return (
                    <div
                      key={s.key}
                      onClick={() => {
                        if (onSelectSession) {
                          onSelectSession(s.key);
                          setIsSessionModalOpen(false);
                        }
                      }}
                      className={`p-3.5 rounded-xl border transition-all cursor-pointer select-none relative group ${
                        isCurrent
                          ? 'bg-gradient-to-r from-cyan-950/80 via-slate-900/90 to-cyan-950/60 border-cyan-400/80 shadow-[0_0_20px_rgba(0,229,255,0.2)]'
                          : 'bg-slate-900/70 hover:bg-slate-900 border-cyan-500/25 hover:border-cyan-400/50'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2 mb-1.5">
                        <div className="flex items-center gap-2 flex-wrap">
                          {isCurrent ? (
                            <span className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-cyan-500/25 border border-cyan-400/60 text-cyan-300 text-[9px] font-hud font-bold uppercase tracking-wider animate-pulse">
                              <Radio className="w-2.5 h-2.5 text-cyan-300" /> ACTIVE
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 rounded-md bg-slate-950 border border-slate-700 text-slate-400 text-[9px] font-mono">
                              RESUMABLE
                            </span>
                          )}

                          {s.channel && (
                            <span className="px-2 py-0.5 rounded-md bg-purple-950/60 border border-purple-500/30 text-purple-300 text-[9px] font-mono uppercase font-bold">
                              {s.channel}
                            </span>
                          )}

                          {s.model && (
                            <span className="px-2 py-0.5 rounded-md bg-cyan-950/50 border border-cyan-500/30 text-cyan-300 text-[9px] font-mono">
                              {s.model}
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-1 text-[10px] font-mono text-slate-400 shrink-0">
                          <Clock className="w-3 h-3 text-cyan-400/70" />
                          <span>{formatRelativeTime(s.updatedAt)}</span>
                        </div>
                      </div>

                      {/* Session Title */}
                      <h4 className="text-xs font-bold text-slate-100 group-hover:text-cyan-200 transition-colors line-clamp-1 font-hud tracking-wide">
                        {title}
                      </h4>

                      {/* Last Message Snippet */}
                      {preview && (
                        <p className="mt-1 text-[11px] text-slate-400 line-clamp-2 leading-relaxed font-sans">
                          {preview}
                        </p>
                      )}

                      {/* Bottom Footer Details */}
                      <div className="mt-2 pt-2 border-t border-cyan-500/10 flex items-center justify-between text-[9px] font-mono text-slate-500">
                        <span className="truncate max-w-xs text-slate-400">
                          KEY: {s.key}
                        </span>
                        {s.totalTokens ? (
                          <span className="text-cyan-400/80">
                            {s.totalTokens.toLocaleString()} tokens
                          </span>
                        ) : null}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
