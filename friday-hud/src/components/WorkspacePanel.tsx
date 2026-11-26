import React, { useState, useEffect } from 'react';
import {
  HardDrive,
  FileText,
  Table,
  Calendar,
  CheckSquare,
  Mail,
  ExternalLink,
  RefreshCw,
  Plus,
  Search,
  CheckCircle2,
  Circle,
  AlertCircle,
  ShieldCheck,
  Video,
  Send,
  X,
  Sparkles,
  Link2
} from 'lucide-react';
import { DriveFile, WorkspaceTask, WorkspaceStatus } from '../types';

export const WorkspacePanel: React.FC = () => {
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [activeSubTab, setActiveSubTab] = useState<'drive' | 'calendar' | 'tasks' | 'gmail'>('gmail');
  const [loading, setLoading] = useState<boolean>(false);
  const [authLoading, setAuthLoading] = useState<boolean>(false);
  const [authUrl, setAuthUrl] = useState<string>('');
  const [showAuthModal, setShowAuthModal] = useState<boolean>(false);

  // Custom OAuth Client state
  const [customClientId, setCustomClientId] = useState<string>('');
  const [customClientSecret, setCustomClientSecret] = useState<string>('');
  const [isSavingClient, setIsSavingClient] = useState<boolean>(false);
  const [clientSaveSuccess, setClientSaveSuccess] = useState<boolean>(false);

  // Drive state
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isSearching, setIsSearching] = useState<boolean>(false);
  const [newDocTitle, setNewDocTitle] = useState<string>('');
  const [showNewDocModal, setShowNewDocModal] = useState<boolean>(false);

  // Calendar state
  const [events, setEvents] = useState<any[]>([]);
  const [showNewEventModal, setShowNewEventModal] = useState<boolean>(false);
  const [eventSummary, setEventSummary] = useState<string>('');
  const [eventStart, setEventStart] = useState<string>('');
  const [eventEnd, setEventEnd] = useState<string>('');

  // Tasks state
  const [tasks, setTasks] = useState<WorkspaceTask[]>([]);
  const [newTaskTitle, setNewTaskTitle] = useState<string>('');

  // Gmail state
  const [emails, setEmails] = useState<any[]>([]);
  const [showComposeModal, setShowComposeModal] = useState<boolean>(false);
  const [sendTo, setSendTo] = useState<string>('');
  const [sendSubject, setSendSubject] = useState<string>('');
  const [sendBody, setSendBody] = useState<string>('');
  const [isSending, setIsSending] = useState<boolean>(false);

  const fetchWorkspaceData = async () => {
    if (!window.electronAPI) return;
    setLoading(true);
    try {
      const s = await window.electronAPI.getWorkspaceStatus();
      setStatus(s);

      // Fetch emails (works on both direct app pass and oauth)
      try {
        const mailList = await window.electronAPI.getUnreadEmails();
        setEmails(mailList || []);
      } catch (e) {
        console.warn('Mail fetch error:', e);
      }

      // Fetch calendar events
      try {
        const evList = await window.electronAPI.getEvents();
        setEvents(evList || []);
      } catch (e) {
        console.warn('Events fetch error:', e);
      }

      // If OAuth is active, fetch Drive & Tasks
      if (s?.has_oauth) {
        try {
          const fileList = await window.electronAPI.listDriveFiles(25);
          setFiles(fileList || []);
        } catch (e) {
          console.warn('Drive files fetch error:', e);
        }

        try {
          const taskList = await window.electronAPI.getTasks();
          setTasks(taskList || []);
        } catch (e) {
          console.warn('Tasks fetch error:', e);
        }
      }
    } catch (err) {
      console.error('Workspace fetch failed:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchWorkspaceData();
    const interval = setInterval(fetchWorkspaceData, 45000);
    return () => clearInterval(interval);
  }, []);

  const handleStartOAuth = async () => {
    if (!window.electronAPI) return;
    setAuthLoading(true);
    try {
      const res = await window.electronAPI.getAuthUrl();
      if (res?.url) {
        setAuthUrl(res.url);
        setShowAuthModal(true);
      }
      // Also trigger background server login
      window.electronAPI.loginGoogle();
    } catch (e) {
      console.error('OAuth launch error:', e);
    } finally {
      setAuthLoading(false);
    }
  };

  const openGcpConsole = () => {
    if (window.electronAPI?.openWorkspaceApp) {
      window.electronAPI.openWorkspaceApp('gcp-console');
    }
    // Also trigger direct xdg-open for certainty
    if (window.electronAPI?.osExec) {
      window.electronAPI.osExec({ cmd: 'xdg-open "https://console.cloud.google.com/apis/credentials?project=careerlens-1"' });
    }
  };

  const handleSaveAndAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!window.electronAPI || !customClientId.trim()) return;
    setIsSavingClient(true);
    try {
      await window.electronAPI.setOAuthClient(customClientId.trim(), customClientSecret.trim());
      setClientSaveSuccess(true);
      const res = await window.electronAPI.getAuthUrl();
      if (res?.url) {
        setAuthUrl(res.url);
      }
      window.electronAPI.loginGoogle();
      setTimeout(() => {
        fetchWorkspaceData();
      }, 3000);
    } catch (err) {
      console.error('Save OAuth client error:', err);
    } finally {
      setIsSavingClient(false);
    }
  };

  const handleSearchDrive = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!window.electronAPI || !searchQuery.trim()) return;
    setIsSearching(true);
    try {
      const results = await window.electronAPI.searchDrive(searchQuery, 25);
      setFiles(results || []);
    } catch (err) {
      console.error('Drive search error:', err);
    } finally {
      setIsSearching(false);
    }
  };

  const handleCreateDoc = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!window.electronAPI || !newDocTitle.trim()) return;
    try {
      const res = await window.electronAPI.createDoc(newDocTitle, `Created autonomously by F.R.I.D.A.Y on ${new Date().toLocaleString()}`);
      if (res?.url) {
        window.open(res.url, '_blank');
      }
      setShowNewDocModal(false);
      setNewDocTitle('');
      fetchWorkspaceData();
    } catch (e) {
      console.error('Create doc error:', e);
    }
  };

  const handleCreateTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!window.electronAPI || !newTaskTitle.trim()) return;
    try {
      await window.electronAPI.createTask(newTaskTitle);
      setNewTaskTitle('');
      const updated = await window.electronAPI.getTasks();
      setTasks(updated || []);
    } catch (e) {
      console.error('Create task error:', e);
    }
  };

  const handleCompleteTask = async (taskId: string) => {
    if (!window.electronAPI) return;
    try {
      await window.electronAPI.completeTask(taskId);
      setTasks((prev) => prev.filter((t) => t.id !== taskId));
    } catch (e) {
      console.error('Complete task error:', e);
    }
  };

  const handleSendEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!window.electronAPI || !sendTo || !sendSubject) return;
    setIsSending(true);
    try {
      const res = await window.electronAPI.sendEmail({
        to: sendTo,
        subject: sendSubject,
        body: sendBody
      });
      if (res?.success) {
        setShowComposeModal(false);
        setSendTo('');
        setSendSubject('');
        setSendBody('');
        fetchWorkspaceData();
      }
    } catch (e) {
      console.error('Send email error:', e);
    } finally {
      setIsSending(false);
    }
  };

  const openApp = (app: string) => {
    if (window.electronAPI?.openWorkspaceApp) {
      window.electronAPI.openWorkspaceApp(app);
    }
  };

  return (
    <div className="flex-1 flex flex-col p-4 md:p-6 overflow-hidden bg-slate-950/70 backdrop-blur-xl animate-fade-in relative">
      {/* 1-Click Auth Modal */}
      {showAuthModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-cyan-500/40 rounded-2xl p-6 max-w-xl w-full shadow-[0_0_50px_rgba(0,229,255,0.25)] max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-3 border-b border-cyan-500/20">
              <div className="flex items-center gap-2 text-cyan-300">
                <Sparkles className="w-5 h-5 text-cyan-400" />
                <h3 className="font-hud font-bold text-sm tracking-wider uppercase">Connect Google Workspace</h3>
              </div>
              <button onClick={() => setShowAuthModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="my-4 space-y-4 text-xs text-slate-300 leading-relaxed font-sans">
              <div className="p-3 bg-cyan-950/40 border border-cyan-500/30 rounded-xl space-y-1.5 font-mono text-[11px] text-cyan-200">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-cyan-300 flex items-center gap-1.5">
                    <ShieldCheck className="w-4 h-4 text-cyan-400" /> Step 1: Get Desktop Client ID (careerlens-1)
                  </span>
                  <button
                    type="button"
                    onClick={openGcpConsole}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/50 text-cyan-300 font-hud text-[10px] uppercase font-bold transition-all cursor-pointer"
                  >
                    Open GCP Credentials <ExternalLink className="w-3 h-3" />
                  </button>
                </div>
                <div className="text-slate-300 font-sans text-xs pt-1 space-y-1">
                  <div>1. In Google Cloud Console, click <strong className="text-cyan-200">+ CREATE CREDENTIALS</strong> &gt; <strong className="text-cyan-200">OAuth client ID</strong>.</div>
                  <div>2. Application type: <strong className="text-cyan-200">Desktop app</strong>, Name: <strong className="text-cyan-200">Friday</strong>, click <strong className="text-cyan-200">Create</strong>.</div>
                  <div>3. Copy and paste your Client ID &amp; Secret below:</div>
                </div>
              </div>

              {/* Client ID & Secret Form */}
              <form onSubmit={handleSaveAndAuth} className="space-y-3 p-3.5 bg-slate-950/70 border border-cyan-500/20 rounded-xl">
                <div>
                  <label className="text-[10px] font-mono text-cyan-300/80 block mb-1">
                    Client ID (ends with .apps.googleusercontent.com)
                  </label>
                  <input
                    type="text"
                    value={customClientId}
                    onChange={(e) => setCustomClientId(e.target.value)}
                    placeholder="e.g. 202306950137-xxx.apps.googleusercontent.com"
                    required
                    className="w-full px-3 py-1.5 text-xs bg-slate-900 border border-cyan-500/30 rounded-lg text-slate-100 font-mono focus:border-cyan-400 focus:outline-none placeholder:text-slate-600"
                  />
                </div>

                <div>
                  <label className="text-[10px] font-mono text-cyan-300/80 block mb-1">
                    Client Secret (starts with GOCSPX-)
                  </label>
                  <input
                    type="password"
                    value={customClientSecret}
                    onChange={(e) => setCustomClientSecret(e.target.value)}
                    placeholder="e.g. GOCSPX-xxxxxxxxxxxx"
                    required
                    className="w-full px-3 py-1.5 text-xs bg-slate-900 border border-cyan-500/30 rounded-lg text-slate-100 font-mono focus:border-cyan-400 focus:outline-none placeholder:text-slate-600"
                  />
                </div>

                <div className="flex items-center justify-between pt-1">
                  <div className="text-[11px] text-slate-400 font-mono">
                    {clientSaveSuccess ? <span className="text-emerald-400">✓ Credentials configured</span> : 'Saved locally in ~/.friday/'}
                  </div>
                  <button
                    type="submit"
                    disabled={isSavingClient || !customClientId.trim()}
                    className="px-4 py-1.5 rounded-lg text-xs font-hud font-semibold bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-slate-950 flex items-center gap-1.5 shadow-[0_0_15px_rgba(0,229,255,0.4)] cursor-pointer disabled:opacity-50"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    {isSavingClient ? 'Saving & Starting...' : 'Save & Connect'}
                  </button>
                </div>
              </form>

              {/* Unverified app warning bypass tip */}
              <div className="p-3 bg-amber-950/30 border border-amber-500/40 rounded-xl space-y-1 text-xs">
                <div className="flex items-center gap-1.5 font-hud font-bold text-amber-300 uppercase tracking-wide">
                  <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
                  How to bypass Google&apos;s &quot;App Not Verified&quot; Screen:
                </div>
                <p className="text-slate-300 font-sans leading-relaxed text-[11px]">
                  When Google opens in Chrome, you may see <strong className="text-amber-200">&quot;This app hasn&apos;t been verified by Google&quot;</strong>. 
                  Simply click <strong className="text-cyan-300">&quot;Advanced&quot;</strong> at the bottom left, then click <strong className="text-cyan-300">&quot;Go to Friday (unsafe)&quot;</strong>, and click <strong className="text-cyan-300">&quot;Continue&quot;</strong>.
                </p>
              </div>

              {authUrl && (
                <div className="pt-1">
                  <span className="text-[10px] font-mono text-slate-400 block mb-1">If the browser didn&apos;t open automatically, click here:</span>
                  <a
                    href={authUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/40 text-cyan-300 font-mono text-xs transition-colors truncate max-w-full"
                  >
                    <Link2 className="w-3.5 h-3.5 shrink-0" />
                    Open Google Consent Page in Chrome <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-cyan-500/20">
              <button
                onClick={() => {
                  setShowAuthModal(false);
                  fetchWorkspaceData();
                }}
                className="px-4 py-1.5 rounded-lg text-xs font-hud font-semibold bg-cyan-500 hover:bg-cyan-400 text-slate-950 transition-all shadow-[0_0_15px_rgba(0,229,255,0.4)] cursor-pointer"
              >
                I&apos;ve Approved — Sync Now
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Compose Email Modal */}
      {showComposeModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/85 backdrop-blur-md flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-cyan-500/40 rounded-2xl p-6 max-w-md w-full shadow-2xl">
            <div className="flex items-center justify-between pb-3 border-b border-cyan-500/20">
              <h3 className="font-hud font-bold text-sm text-cyan-300 tracking-wider uppercase flex items-center gap-2">
                <Mail className="w-4 h-4 text-cyan-400" /> Fast Compose Email
              </h3>
              <button onClick={() => setShowComposeModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleSendEmail} className="mt-4 space-y-3">
              <div>
                <label className="text-[10px] font-mono text-cyan-300/80 block mb-1">To</label>
                <input
                  type="email"
                  value={sendTo}
                  onChange={(e) => setSendTo(e.target.value)}
                  placeholder="recipient@example.com"
                  required
                  className="w-full px-3 py-1.5 text-xs bg-slate-950 border border-cyan-500/30 rounded-lg text-slate-100 font-mono focus:border-cyan-400 focus:outline-none"
                />
              </div>
              <div>
                <label className="text-[10px] font-mono text-cyan-300/80 block mb-1">Subject</label>
                <input
                  type="text"
                  value={sendSubject}
                  onChange={(e) => setSendSubject(e.target.value)}
                  placeholder="Email Subject"
                  required
                  className="w-full px-3 py-1.5 text-xs bg-slate-950 border border-cyan-500/30 rounded-lg text-slate-100 font-mono focus:border-cyan-400 focus:outline-none"
                />
              </div>
              <div>
                <label className="text-[10px] font-mono text-cyan-300/80 block mb-1">Message</label>
                <textarea
                  rows={4}
                  value={sendBody}
                  onChange={(e) => setSendBody(e.target.value)}
                  placeholder="Type message content..."
                  required
                  className="w-full px-3 py-1.5 text-xs bg-slate-950 border border-cyan-500/30 rounded-lg text-slate-100 font-mono focus:border-cyan-400 focus:outline-none resize-none"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="submit"
                  disabled={isSending}
                  className="px-4 py-1.5 rounded-lg text-xs font-hud font-semibold bg-cyan-500 hover:bg-cyan-400 text-slate-950 flex items-center gap-1.5 shadow-[0_0_15px_rgba(0,229,255,0.4)]"
                >
                  <Send className="w-3.5 h-3.5" />
                  {isSending ? 'Sending...' : 'Send Message'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Top Header & Workspace Connection Banner */}
      <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 pb-4 border-b border-cyan-500/20">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-cyan-500/10 border border-cyan-500/30 text-cyan-400">
              <HardDrive className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold font-hud tracking-wider text-slate-100 uppercase flex items-center gap-2">
                Google Workspace Control Center
              </h2>
              <p className="text-xs text-slate-400 font-sans">
                Full-spectrum operational access to Drive, Docs, Sheets, Calendar, Tasks & Gmail
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2.5 flex-wrap">
          {/* Account Indicator */}
          <div className="px-3 py-1 rounded-xl bg-slate-900/80 border border-cyan-500/30 flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${status?.has_oauth ? 'bg-emerald-400 shadow-[0_0_8px_#10b981]' : (status?.has_direct_auth ? 'bg-amber-400 shadow-[0_0_8px_#f59e0b]' : 'bg-rose-500')}`} />
            <span className="text-xs font-mono text-cyan-200 truncate max-w-[200px]">
              {status?.email || 'Not Connected'}
            </span>
            <span className={`px-1.5 py-0.5 rounded text-[9px] font-mono uppercase font-semibold ${status?.has_oauth ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40' : 'bg-amber-500/20 text-amber-300 border border-amber-500/40'}`}>
              {status?.has_oauth ? 'Full OAuth' : (status?.has_direct_auth ? 'Gmail Direct' : 'Disconnected')}
            </span>
          </div>

          {/* 1-Click Full Workspace Auth Button */}
          {!status?.has_oauth && (
            <button
              onClick={handleStartOAuth}
              disabled={authLoading}
              className="px-3 py-1.5 rounded-xl text-xs font-hud font-bold uppercase tracking-wider bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 text-slate-950 flex items-center gap-1.5 shadow-[0_0_20px_rgba(0,229,255,0.4)] transition-all cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5" />
              {authLoading ? 'Launching...' : 'Authorize Full Workspace (1-Click)'}
            </button>
          )}

          {/* Refresh Button */}
          <button
            onClick={fetchWorkspaceData}
            disabled={loading}
            className="p-1.5 rounded-xl bg-cyan-950/50 border border-cyan-500/30 text-cyan-300 hover:text-cyan-100 hover:border-cyan-400 transition-colors"
            title="Refresh Workspace Data"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Quick Launch App Bar */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 my-3">
        {[
          { name: 'Gmail', icon: <Mail className="w-4 h-4 text-rose-400" />, app: 'gmail' },
          { name: 'Drive', icon: <HardDrive className="w-4 h-4 text-emerald-400" />, app: 'drive' },
          { name: 'Calendar', icon: <Calendar className="w-4 h-4 text-blue-400" />, app: 'calendar' },
          { name: 'Docs', icon: <FileText className="w-4 h-4 text-cyan-400" />, app: 'docs' },
          { name: 'Sheets', icon: <Table className="w-4 h-4 text-emerald-500" />, app: 'sheets' },
          { name: 'Meet', icon: <Video className="w-4 h-4 text-amber-400" />, app: 'meet' },
        ].map((item) => (
          <button
            key={item.app}
            onClick={() => openApp(item.app)}
            className="flex items-center justify-center gap-2 py-2 px-3 rounded-xl bg-slate-900/60 border border-cyan-500/20 hover:border-cyan-400/50 hover:bg-cyan-950/30 transition-all text-xs font-hud font-semibold text-slate-200 group shadow-sm cursor-pointer"
          >
            {item.icon}
            <span className="group-hover:text-cyan-200 transition-colors">{item.name}</span>
            <ExternalLink className="w-2.5 h-2.5 opacity-40 group-hover:opacity-100 text-cyan-400" />
          </button>
        ))}
      </div>

      {/* Workspace Sub-Navigation Tabs */}
      <div className="flex items-center gap-2 border-b border-cyan-500/20 pb-2 mb-3">
        {[
          { id: 'drive', label: 'Drive & Docs', icon: <HardDrive className="w-3.5 h-3.5" />, badge: files.length },
          { id: 'calendar', label: 'Calendar Schedule', icon: <Calendar className="w-3.5 h-3.5" />, badge: events.length },
          { id: 'tasks', label: 'Google Tasks', icon: <CheckSquare className="w-3.5 h-3.5" />, badge: tasks.length },
          { id: 'gmail', label: 'Gmail Inbox', icon: <Mail className="w-3.5 h-3.5" />, badge: emails.length },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveSubTab(tab.id as any)}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-hud font-semibold uppercase tracking-wider transition-all cursor-pointer ${
              activeSubTab === tab.id
                ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-400/50 shadow-[0_0_12px_rgba(0,229,255,0.25)]'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/50 border border-transparent'
            }`}
          >
            {tab.icon}
            <span>{tab.label}</span>
            {tab.badge > 0 && (
              <span className="px-1.5 py-0.2 rounded-full text-[9px] font-mono bg-cyan-950 text-cyan-300 border border-cyan-500/30">
                {tab.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto pr-1">
        {/* TAB 1: GOOGLE DRIVE & DOCS */}
        {activeSubTab === 'drive' && (
          <div className="space-y-4">
            {!status?.has_oauth && (
              <div className="p-4 rounded-xl bg-amber-950/30 border border-amber-500/40 flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                <div className="flex-1 text-xs">
                  <h4 className="font-hud font-bold text-amber-200 uppercase tracking-wider mb-1">
                    Drive & Docs Require 1-Click OAuth
                  </h4>
                  <p className="text-slate-300 leading-relaxed font-sans mb-2">
                    Google strictly forbids legacy App Passwords from accessing Google Drive and Google Docs. 
                    Click below to authorize full Workspace access in your browser — zero console setup required.
                  </p>
                  <button
                    onClick={handleStartOAuth}
                    className="px-3 py-1 rounded-lg text-xs font-hud font-semibold bg-amber-400 text-slate-950 hover:bg-amber-300 transition-colors cursor-pointer"
                  >
                    Authorize Google Drive & Docs
                  </button>
                </div>
              </div>
            )}

            {/* Drive Search Bar & Create Doc Action */}
            <div className="flex items-center gap-2">
              <form onSubmit={handleSearchDrive} className="flex-1 flex items-center gap-2 bg-slate-900/80 border border-cyan-500/30 rounded-xl px-3 py-1.5 focus-within:border-cyan-400">
                <Search className="w-4 h-4 text-cyan-400 shrink-0" />
                <input
                  type="text"
                  placeholder="Search files in Google Drive..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="bg-transparent text-xs text-slate-100 font-sans focus:outline-none w-full placeholder:text-slate-500"
                />
                {searchQuery && (
                  <button type="button" onClick={() => { setSearchQuery(''); fetchWorkspaceData(); }} className="text-slate-400 hover:text-white">
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </form>

              <button
                onClick={() => setShowNewDocModal(true)}
                className="px-3 py-2 rounded-xl text-xs font-hud font-semibold bg-cyan-950/70 border border-cyan-500/40 text-cyan-300 hover:bg-cyan-900/70 hover:border-cyan-400 flex items-center gap-1.5 transition-colors cursor-pointer shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                New Doc
              </button>
            </div>

            {/* New Doc Modal Inline */}
            {showNewDocModal && (
              <div className="p-3 bg-slate-900/90 border border-cyan-500/40 rounded-xl flex items-center gap-2 animate-fade-in">
                <FileText className="w-4 h-4 text-cyan-400 shrink-0" />
                <input
                  type="text"
                  placeholder="Enter Google Doc title..."
                  value={newDocTitle}
                  onChange={(e) => setNewDocTitle(e.target.value)}
                  className="flex-1 px-2.5 py-1 text-xs bg-slate-950 border border-cyan-500/30 rounded-lg text-slate-100 font-sans focus:border-cyan-400 focus:outline-none"
                />
                <button
                  onClick={handleCreateDoc}
                  className="px-3 py-1 rounded-lg text-xs font-hud font-semibold bg-cyan-500 text-slate-950 hover:bg-cyan-400 transition-colors"
                >
                  Create & Open
                </button>
                <button
                  onClick={() => setShowNewDocModal(false)}
                  className="p-1 text-slate-400 hover:text-white"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

            {/* Files Grid / List */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {files.map((file) => (
                <div
                  key={file.id}
                  className="p-3 rounded-xl bg-slate-900/50 border border-slate-800 hover:border-cyan-500/40 transition-all flex items-start justify-between gap-2 group"
                >
                  <div className="flex items-start gap-2.5 min-w-0">
                    <div className="p-2 rounded-lg bg-slate-800/80 text-cyan-400 shrink-0 mt-0.5">
                      {file.mimeType.includes('document') ? (
                        <FileText className="w-4 h-4 text-cyan-400" />
                      ) : file.mimeType.includes('spreadsheet') ? (
                        <Table className="w-4 h-4 text-emerald-400" />
                      ) : (
                        <HardDrive className="w-4 h-4 text-blue-400" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <h4 className="text-xs font-semibold text-slate-200 truncate group-hover:text-cyan-300 transition-colors">
                        {file.name}
                      </h4>
                      <p className="text-[10px] font-mono text-slate-400 mt-0.5">
                        {file.modifiedTime ? new Date(file.modifiedTime).toLocaleDateString() : 'Recent'}
                      </p>
                    </div>
                  </div>

                  {file.webViewLink && (
                    <a
                      href={file.webViewLink}
                      target="_blank"
                      rel="noreferrer"
                      className="p-1.5 rounded-lg text-slate-400 hover:text-cyan-300 hover:bg-cyan-950/40 transition-colors"
                      title="Open in Google Drive"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  )}
                </div>
              ))}

              {files.length === 0 && (
                <div className="col-span-full py-12 text-center text-slate-500 text-xs font-mono">
                  {status?.has_oauth ? 'No files found matching your search.' : 'Authorize Google Workspace to view and search all files in your Google Drive.'}
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 2: GOOGLE CALENDAR */}
        {activeSubTab === 'calendar' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-hud font-bold text-slate-300 uppercase tracking-wider flex items-center gap-2">
                <Calendar className="w-4 h-4 text-cyan-400" /> Today&apos;s Live Calendar Events
              </h3>
              <button
                onClick={() => openApp('calendar')}
                className="text-[11px] font-mono text-cyan-400 hover:underline flex items-center gap-1"
              >
                Open Google Calendar <ExternalLink className="w-2.5 h-2.5" />
              </button>
            </div>

            <div className="space-y-2">
              {events.map((ev, idx) => (
                <div
                  key={ev.id || idx}
                  className="p-3 rounded-xl bg-slate-900/50 border border-cyan-500/20 flex items-center justify-between gap-3"
                >
                  <div className="flex items-center gap-3">
                    <span className="px-2 py-1 rounded bg-cyan-950 border border-cyan-500/30 text-[10px] font-mono text-cyan-300 font-semibold shrink-0">
                      {ev.time || 'Scheduled'}
                    </span>
                    <div>
                      <h4 className="text-xs font-semibold text-slate-200">{ev.summary}</h4>
                      {ev.location && <p className="text-[10px] text-slate-400 font-mono">{ev.location}</p>}
                    </div>
                  </div>
                  {ev.link && (
                    <a
                      href={ev.link}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs font-mono text-cyan-400 hover:underline flex items-center gap-1"
                    >
                      View <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </div>
              ))}

              {events.length === 0 && (
                <div className="p-8 rounded-xl bg-slate-900/30 border border-dashed border-slate-800 text-center">
                  <Calendar className="w-8 h-8 text-slate-600 mx-auto mb-2" />
                  <p className="text-xs font-sans text-slate-400">No events scheduled on your Google Calendar for today.</p>
                  <p className="text-[11px] font-mono text-cyan-400/70 mt-1">Full schedule availability detected for deep development work.</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 3: GOOGLE TASKS */}
        {activeSubTab === 'tasks' && (
          <div className="space-y-4">
            {/* Add Task Input */}
            <form onSubmit={handleCreateTask} className="flex items-center gap-2">
              <input
                type="text"
                placeholder="Add a new Google Task..."
                value={newTaskTitle}
                onChange={(e) => setNewTaskTitle(e.target.value)}
                className="flex-1 px-3 py-2 text-xs bg-slate-900/80 border border-cyan-500/30 rounded-xl text-slate-100 font-sans focus:border-cyan-400 focus:outline-none"
              />
              <button
                type="submit"
                className="px-4 py-2 rounded-xl text-xs font-hud font-semibold bg-cyan-500 text-slate-950 hover:bg-cyan-400 transition-colors flex items-center gap-1.5 shadow-[0_0_12px_rgba(0,229,255,0.3)] cursor-pointer shrink-0"
              >
                <Plus className="w-3.5 h-3.5" /> Add Task
              </button>
            </form>

            {/* Task Items */}
            <div className="space-y-2">
              {tasks.map((t) => (
                <div
                  key={t.id}
                  onClick={() => handleCompleteTask(t.id)}
                  className="p-3 rounded-xl bg-slate-900/50 border border-slate-800 hover:border-cyan-500/40 flex items-center justify-between gap-3 cursor-pointer group transition-all"
                >
                  <div className="flex items-center gap-3">
                    <Circle className="w-4 h-4 text-slate-500 group-hover:text-cyan-400 transition-colors shrink-0" />
                    <div>
                      <h4 className="text-xs font-semibold text-slate-200 group-hover:text-cyan-200 transition-colors">
                        {t.title}
                      </h4>
                      {t.notes && <p className="text-[10px] text-slate-400 font-sans">{t.notes}</p>}
                    </div>
                  </div>
                  <span className="text-[10px] font-mono text-slate-500 group-hover:text-cyan-400/80 opacity-0 group-hover:opacity-100 transition-opacity">
                    Click to Complete
                  </span>
                </div>
              ))}

              {tasks.length === 0 && (
                <div className="p-8 rounded-xl bg-slate-900/30 border border-dashed border-slate-800 text-center">
                  <CheckSquare className="w-8 h-8 text-slate-600 mx-auto mb-2" />
                  <p className="text-xs font-sans text-slate-400">All Google Tasks completed.</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* TAB 4: GMAIL INBOX */}
        {activeSubTab === 'gmail' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-hud font-bold text-slate-300 uppercase tracking-wider flex items-center gap-2">
                <Mail className="w-4 h-4 text-cyan-400" /> Recent Incoming Messages ({emails.length})
              </h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowComposeModal(true)}
                  className="px-3 py-1.5 rounded-lg text-xs font-hud font-semibold bg-cyan-500 text-slate-950 hover:bg-cyan-400 flex items-center gap-1.5 transition-colors cursor-pointer shadow-[0_0_10px_rgba(0,229,255,0.3)]"
                >
                  <Send className="w-3 h-3" /> Fast Compose
                </button>
                <button
                  onClick={() => openApp('gmail')}
                  className="text-[11px] font-mono text-cyan-400 hover:underline flex items-center gap-1"
                >
                  Open Gmail <ExternalLink className="w-2.5 h-2.5" />
                </button>
              </div>
            </div>

            <div className="space-y-2">
              {emails.map((m) => (
                <div
                  key={m.id}
                  className="p-3 rounded-xl bg-slate-900/50 border border-slate-800 hover:border-cyan-500/30 transition-all flex flex-col gap-1"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-slate-200 truncate">{m.sender}</span>
                    <span className="text-[10px] font-mono text-slate-400 shrink-0">{m.date ? new Date(m.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</span>
                  </div>
                  <h4 className="text-xs text-cyan-300 font-medium truncate">{m.subject}</h4>
                  {m.snippet && (
                    <p className="text-[11px] text-slate-400 line-clamp-2 font-sans">{m.snippet}</p>
                  )}
                </div>
              ))}

              {emails.length === 0 && (
                <div className="p-8 rounded-xl bg-slate-900/30 border border-dashed border-slate-800 text-center">
                  <Mail className="w-8 h-8 text-slate-600 mx-auto mb-2" />
                  <p className="text-xs font-sans text-slate-400">Inbox clear. No unread messages.</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

