import React, { useState, useEffect } from 'react';
import {
  Sparkles,
  RefreshCw,
  Mail,
  Key,
  ExternalLink,
  Volume2,
  X
} from 'lucide-react';
import { AgendaItem, DayPlan, WorkspaceStatus } from '../types';

export const AgendaCard: React.FC = () => {
  // Real agenda from ~/.friday/agenda.json (or the day planner); empty until loaded.
  const [items, setItems] = useState<AgendaItem[]>([]);
  const [briefing, setBriefing] = useState<string>('');
  const [emailSummary, setEmailSummary] = useState<string>('');
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [isGoogleConnected, setIsGoogleConnected] = useState<boolean>(false);
  const [isPlanning, setIsPlanning] = useState<boolean>(false);
  const [isSpeaking, setIsSpeaking] = useState<boolean>(false);

  // Direct Auth Modal state
  const [showAuthModal, setShowAuthModal] = useState<boolean>(false);
  const [authEmail, setAuthEmail] = useState<string>('');
  const [appPassword, setAppPassword] = useState<string>('');
  const [calendarUrl, setCalendarUrl] = useState<string>('');
  const [authSubmitting, setAuthSubmitting] = useState<boolean>(false);

  const fetchStatusAndAgenda = async () => {
    if (!window.electronAPI) return;
    try {
      const s = await window.electronAPI.getWorkspaceStatus();
      setStatus(s);
      setIsGoogleConnected(Boolean(s?.authenticated));
      
      const plan: DayPlan = await window.electronAPI.getAgenda();
      if (plan && plan.agenda && plan.agenda.length > 0) {
        setItems(plan.agenda);
        if (plan.briefing) setBriefing(plan.briefing);
        if (plan.emailSummary) setEmailSummary(plan.emailSummary);
      }
    } catch (err) {
      console.warn('Failed to load agenda/status:', err);
    }
  };

  useEffect(() => {
    fetchStatusAndAgenda();
    const interval = setInterval(fetchStatusAndAgenda, 30000);
    return () => clearInterval(interval);
  }, []);

  const handlePlanDay = async () => {
    if (!window.electronAPI || isPlanning) return;
    setIsPlanning(true);
    try {
      const res = await window.electronAPI.planDay();
      if (res && res.agenda) {
        setItems(res.agenda);
        if (res.briefing) setBriefing(res.briefing);
        if (res.emailSummary) setEmailSummary(res.emailSummary);
      }
      const status = await window.electronAPI.getWorkspaceStatus();
      setIsGoogleConnected(Boolean(status?.authenticated));
    } catch (err) {
      console.error('Day planning failed:', err);
    } finally {
      setIsPlanning(false);
    }
  };

  const handleSpeakBriefing = async () => {
    if (!window.electronAPI || !briefing || isSpeaking) return;
    setIsSpeaking(true);
    try {
      await window.electronAPI.synthesizeSpeech(briefing, 'en-IE-EmilyNeural');
    } catch (e) {
      console.error('Speech synthesis error:', e);
    } finally {
      setTimeout(() => setIsSpeaking(false), 3000);
    }
  };

  const handleSubmitDirectAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!window.electronAPI || !appPassword.trim()) return;
    setAuthSubmitting(true);
    try {
      const res = await window.electronAPI.setDirectAuth(authEmail, appPassword, calendarUrl);
      if (res.success) {
        setShowAuthModal(false);
        setAppPassword('');
        await fetchStatusAndAgenda();
        handlePlanDay();
      }
    } catch (err) {
      console.error('Direct auth failed:', err);
    } finally {
      setAuthSubmitting(false);
    }
  };

  const toggleComplete = (id: string) => {
    setItems((prev) =>
      prev.map((it) => (it.id === id ? { ...it, completed: !it.completed } : it))
    );
  };

  return (
    <div className="sk-plate sk-plate-fill relative overflow-hidden">
      {/* Direct Auth Modal */}
      {showAuthModal && (
        <div className="absolute inset-0 z-50 bg-slate-950/95 backdrop-blur-md p-4 flex flex-col justify-between rounded-2xl border border-cyan-400/50 shadow-2xl animate-fade-in">
          <div className="flex items-center justify-between pb-2 border-b border-cyan-500/30">
            <div className="flex items-center gap-2 text-cyan-300">
              <Key className="w-4 h-4 text-cyan-400" />
              <span className="text-xs font-hud font-bold uppercase tracking-wider">Direct Google Login</span>
            </div>
            <button
              onClick={() => setShowAuthModal(false)}
              className="text-slate-400 hover:text-white transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <form onSubmit={handleSubmitDirectAuth} className="flex flex-col gap-2.5 my-auto">
            <div>
              <label className="text-[10px] font-mono text-cyan-300/80 block mb-1">Google Email</label>
              <input
                type="email"
                value={authEmail}
                onChange={(e) => setAuthEmail(e.target.value)}
                required
                className="w-full px-2.5 py-1 text-xs bg-slate-900/80 border border-cyan-500/30 rounded-lg text-slate-100 font-mono focus:border-cyan-400 focus:outline-none"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[10px] font-mono text-cyan-300/80">Google App Password (16 letters)</label>
                <a
                  href="https://myaccount.google.com/apppasswords"
                  target="_blank"
                  rel="noreferrer"
                  className="text-[9px] font-mono text-cyan-400 hover:underline flex items-center gap-0.5"
                >
                  Generate here <ExternalLink className="w-2.5 h-2.5" />
                </a>
              </div>
              <input
                type="text"
                placeholder="abcd efgh ijkl mnop"
                value={appPassword}
                onChange={(e) => setAppPassword(e.target.value)}
                required
                className="w-full px-2.5 py-1 text-xs bg-slate-900/80 border border-cyan-500/30 rounded-lg text-cyan-200 font-mono tracking-wider focus:border-cyan-400 focus:outline-none"
              />
              <p className="text-[9px] text-slate-400 mt-0.5">
                Bypasses Google 403 blocks. 100% direct access to Gmail & Alerts.
              </p>
            </div>

            <div className="flex gap-2 mt-1">
              <button
                type="submit"
                disabled={authSubmitting}
                className="flex-1 py-1.5 rounded-lg text-xs font-hud font-semibold bg-cyan-500 hover:bg-cyan-400 text-slate-950 transition-all shadow-[0_0_15px_rgba(0,229,255,0.4)] cursor-pointer"
              >
                {authSubmitting ? 'Authenticating...' : 'Connect Workspace'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Header: engraved title, sync lamp, Plan key */}
      <div className="sk-plate-head gap-2 flex-wrap">
        <span className="sk-engraved">Today</span>
        <div className="flex items-center gap-1.5 flex-wrap justify-end min-w-0">
          {isGoogleConnected && status?.has_oauth ? (
            <span className="sk-lamp-wrap" title="Google Workspace synced (Calendar, Drive, Docs, Gmail, Tasks)">
              <span className="sk-lamp sk-lamp-ok sk-lamp-xs" />
              <span className="sk-engraved sk-engraved-sm">Synced</span>
            </span>
          ) : isGoogleConnected && status?.has_direct_auth ? (
            <button
              type="button"
              onClick={() => {
                window.electronAPI?.loginGoogle?.();
                window.electronAPI?.getAuthUrl?.().then((res) => {
                  if (res?.url) window.open(res.url, '_blank');
                });
              }}
              title="Gmail connected. Click to also connect Calendar and Drive."
              className="sk-key sk-key-sm flex items-center gap-1.5"
            >
              <span className="sk-lamp sk-lamp-warn sk-lamp-xs" />
              Gmail only
            </button>
          ) : (
            <button type="button" onClick={() => setShowAuthModal(true)} title="Connect Google Workspace" className="sk-key sk-key-sm flex items-center gap-1">
              <Key className="w-3 h-3" />
              Connect
            </button>
          )}
          <button
            type="button"
            onClick={handlePlanDay}
            disabled={isPlanning}
            title="Build today's plan"
            className={`sk-key sk-key-sm flex items-center gap-1 ${isPlanning ? 'sk-key-lit' : ''}`}
          >
            {isPlanning ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
            {isPlanning ? 'Planning…' : 'Plan'}
          </button>
        </div>
      </div>

      {/* Spoken Briefing Banner */}
      {briefing && (
        <div className="sk-lcd sk-lcd-tight mb-3 flex items-start gap-2.5">
          <button
            type="button"
            onClick={handleSpeakBriefing}
            title="Listen to FRIDAY's briefing"
            className={`sk-btn sk-btn-xs shrink-0 ${isSpeaking ? 'sk-btn-active' : ''}`}
          >
            <Volume2 />
          </button>
          <p className="sk-lcd-text line-clamp-2">
            &ldquo;{briefing}&rdquo;
          </p>
        </div>
      )}

      {/* Timeline List */}
      <div className="sk-well flex-1 min-h-0 overflow-y-auto p-1.5 flex flex-col gap-1">
        {items.length === 0 && (
          <p className="sk-muted px-2 py-2">No plan for today yet. Press Plan to build one.</p>
        )}
        {items.map((it) => (
          <button
            type="button"
            key={it.id}
            onClick={() => toggleComplete(it.id)}
            title={it.completed ? 'Mark as not done' : 'Mark as done'}
            className={`sk-row ${it.active ? 'is-active' : ''} ${it.completed ? 'is-done' : ''}`}
          >
            <span className={`sk-lamp sk-lamp-xs shrink-0 ${it.completed ? 'sk-lamp-ok' : it.active ? 'sk-lamp-cyan' : 'sk-lamp-off'}`} />
            <span className="sk-row-time shrink-0">{it.time}</span>
            <span className="sk-row-title truncate">{it.title}</span>
          </button>
        ))}
      </div>

      {/* Email Inbox Summary Footer */}
      {emailSummary && (
        <div className="mt-2.5 px-1 flex items-center gap-1.5 sk-muted">
          <Mail className="w-3 h-3 shrink-0" />
          <span className="truncate">{emailSummary}</span>
        </div>
      )}
    </div>
  );
};
