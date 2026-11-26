import { ErrorBoundary } from './ErrorBoundary';
import { useStickToBottom } from '../services/use-stick-bottom';
import React, { useState, useEffect, useRef } from 'react';
import { fridayLabel, useFridayInfo } from '../services/friday-info';
import { X, Send, Bot, User, History, Plus } from 'lucide-react';
import { ChatMessage, ActivityStep, SessionItem } from '../types';
import { WorkTrace } from './WorkTrace';
import { WorkingCard } from './WorkingCard';
import { cleanSessionTitle } from '../services/session-title';
import { HudMarkdown } from './HudMarkdown';

interface ChatDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  messages: ChatMessage[];
  onSendMessage: (text: string) => void;
  isThinking?: boolean;
  thinkingContent?: string;
  liveActivities?: ActivityStep[];
  currentSessionKey?: string;
  sessions?: SessionItem[];
  onSelectSession?: (key: string) => void;
  onNewSession?: () => void;
}

export const ChatDrawer: React.FC<ChatDrawerProps> = ({
  isOpen,
  onClose,
  messages,
  onSendMessage,
  isThinking = false,
  thinkingContent = '',
  liveActivities = [],
  currentSessionKey = 'agent:main:main',
  sessions = [],
  onSelectSession,
  onNewSession,
}) => {
  const fridayInfo = useFridayInfo();
  const [input, setInput] = useState('');
  const [showSessionsList, setShowSessionsList] = useState(false);
  const { containerRef, onScroll } = useStickToBottom(messages[messages.length - 1]?.role, [
    messages,
    isThinking,
    thinkingContent,
    liveActivities,
  ]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    onSendMessage(input.trim());
    setInput('');
  };

  const activeSession = sessions.find((s) => s.key === currentSessionKey);

  return (
    <aside className="sk-console w-[420px] max-w-[45%] h-full min-h-0 shrink-0 flex flex-col">
      {/* Header: engraved console plate */}
      <div className="sk-console-head">
        <div className="flex items-center gap-3 min-w-0">
          <div className="sk-badge" aria-hidden>
            <Bot className="w-[18px] h-[18px]" />
          </div>
          <div className="min-w-0">
            <div className="sk-engraved">FRIDAY Comms</div>
            <div className="flex items-center gap-2 mt-1">
              <span className="sk-lcd sk-lcd-chip">
                <span className="sk-lcd-small">{fridayLabel(fridayInfo).toUpperCase()}</span>
              </span>
              <button
                type="button"
                onClick={() => setShowSessionsList(!showSessionsList)}
                aria-expanded={showSessionsList}
                title="Previous chats"
                className={`sk-key sk-key-sm flex items-center gap-1 ${showSessionsList ? 'sk-key-lit' : ''}`}
              >
                <History className="w-3 h-3" />
                <span>{sessions.length} chats</span>
              </button>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {onNewSession && (
            <button type="button" onClick={onNewSession} title="Start a new chat" aria-label="Start a new chat" className="sk-btn">
              <Plus />
            </button>
          )}
          <button type="button" onClick={onClose} title="Close chat" aria-label="Close chat" className="sk-btn sk-btn-danger">
            <X />
          </button>
        </div>
      </div>

      {/* Quick Session Switcher Dropdown */}
      {showSessionsList && (
        <div className="sk-well mx-3 mt-3 p-2.5 max-h-52 overflow-y-auto hud-scroll space-y-1.5">
          <div className="flex items-center justify-between px-1 mb-1">
            <span className="sk-engraved sk-engraved-sm">Recent chats ({sessions.length})</span>
            {onNewSession && (
              <button
                onClick={() => {
                  onNewSession();
                  setShowSessionsList(false);
                }}
                className="sk-key sk-key-sm"
              >
                + New chat
              </button>
            )}
          </div>
          {sessions.map((s) => (
            <div
              key={s.key}
              onClick={() => {
                if (onSelectSession) {
                  onSelectSession(s.key);
                  setShowSessionsList(false);
                }
              }}
              className={`sk-session ${s.key === currentSessionKey ? 'is-active' : ''}`}
            >
              <div className="truncate pr-2">
                <span className="sk-session-title">
                  {cleanSessionTitle(s.derivedTitle || s.label) || s.key}
                </span>
                {s.lastMessagePreview && (
                  <p className="sk-session-preview truncate">
                    {s.lastMessagePreview}
                  </p>
                )}
              </div>
              {s.channel && (
                <span className="sk-tag shrink-0">
                  {s.channel}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Messages List */}
      <div ref={containerRef} onScroll={onScroll} className="sk-screen flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
        {messages.map((m) => (
          <ErrorBoundary key={m.id} compact>
          {m.role === 'system' ? (
            <div key={m.id} className="sk-divider-note" role="note">
              <span className="sk-groove" />
              <span>
                {m.text} · {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
              <span className="sk-groove" />
            </div>
          ) : (
          <div
            key={m.id}
            className={`flex flex-col ${
              m.role === 'user' ? 'items-end' : 'items-start'
            } w-full`}
          >
            <div className="flex items-center gap-2 mb-1">
              {m.role === 'user' ? (
                <>
                  <span className="sk-speaker">You</span>
                  <User className="w-3.5 h-3.5 text-slate-400" />
                </>
              ) : (
                <>
                  <span className="sk-lamp sk-lamp-ok sk-lamp-xs" />
                  <span className="sk-speaker sk-speaker-friday">FRIDAY</span>
                </>
              )}
            </div>

            {/* Cognitive & Action Trace (Thinking + Tool Calls) */}
            {m.role === 'assistant' && (m.thinking || (m.toolCalls && m.toolCalls.length > 0) || (m.activities && m.activities.length > 0)) && (
              <div className="max-w-[90%] w-full">
                <WorkTrace
                  thinking={m.thinking}
                  toolCalls={m.toolCalls}
                  activities={m.activities}
                  isLive={false}
                />
              </div>
            )}

            {/* Message Bubble */}
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

      {/* Input Form */}
      <form
        onSubmit={handleSubmit}
        className="sk-console-foot"
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Message FRIDAY…"
          className="sk-input flex-1"
        />
        <button
          type="submit"
          title="Send"
          aria-label="Send"
          disabled={!input.trim()}
          className="sk-send"
        >
          <Send className="w-4 h-4" />
        </button>
      </form>
    </aside>
  );
};
