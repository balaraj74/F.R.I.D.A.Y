import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { NavItem } from './components/SidebarNav';
import { HudChrome } from './components/HudChrome';
import { GreetingCard } from './components/GreetingCard';
import { ArcReactorCore } from './components/ArcReactorCore';
import { LiveActivity } from './components/LiveActivity';
import { SystemStatusCard } from './components/SystemStatusCard';
import { FocusMediaPlayer } from './components/FocusMediaPlayer';
import { CommandBar } from './components/CommandBar';
import { AgendaCard } from './components/AgendaCard';
import { ActiveProjectCard } from './components/ActiveProjectCard';
import { HolographicGlobe } from './components/HolographicGlobe';
import { ChatDrawer } from './components/ChatDrawer';
import { ProjectsModal } from './components/ProjectsModal';
import { StartupArcReactor } from './components/StartupArcReactor';
import { AvatarStage } from './components/AvatarStage';
import { ChannelsPanel } from './components/ChannelsPanel';
import { SkillsPanel } from './components/SkillsPanel';
import { CronPanel } from './components/CronPanel';
import { ApprovalsPanel } from './components/ApprovalsPanel';
import { LogsPanel } from './components/LogsPanel';
import { ConfigSettingsPanel } from './components/ConfigSettingsPanel';
import { ChatPanel } from './components/ChatPanel';
import { AbilitiesPanel } from './components/AbilitiesPanel';
import { EvolutionPanel } from './components/EvolutionPanel';
import { OpportunityPanel } from './components/OpportunityPanel';
import { WorkspacePanel } from './components/WorkspacePanel';
import { SystemStats, ProjectInfo, ChatMessage, ActivityStep, SessionItem } from './types';
import { EMPTY_STATS, fetchSystemStats } from './services/system-stats';
import { gateway, stripReplyTags } from './services/gateway-ws';
import { mergeHistory, sealStreaming } from './services/chat-merge';
import { speechService } from './services/speech';
import { presence } from './services/presence';
import { useProjects } from './services/projects';
import { voiceLoop } from './services/voice-loop';
import { narrateReplyStarted, narrateTurnEnd, narrateTurnStart, startNarration } from './services/narration';
import { composeMessage, toGatewayAttachments, type Attachment } from './services/attachments';

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<NavItem>('home');
  const [isGatewayConnected, setIsGatewayConnected] = useState(false);
  const [showStartupScreen, setShowStartupScreen] = useState(true);
  const [startupRunning, setStartupRunning] = useState(false);
  const [avatarOk, setAvatarOk] = useState(Boolean(window.electronAPI?.loadAvatar));
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isListening, setIsListening] = useState(speechService.getIsListening());
  const [isVoiceMuted, setIsVoiceMuted] = useState(speechService.isVoiceMuted());
  const hasGreetedRef = useRef(false);
  const thinkingContentRef = useRef('');
  const [liveActivities, setLiveActivities] = useState<ActivityStep[]>([]);
  const liveActivitiesRef = useRef<ActivityStep[]>([]);
  const [currentSessionKey, setCurrentSessionKey] = useState<string>('agent:main:main');
  const sessionKeyRef = useRef(currentSessionKey);
  sessionKeyRef.current = currentSessionKey;
  const [sessionsList, setSessionsList] = useState<SessionItem[]>([]);

  const [systemStats, setSystemStats] = useState<SystemStats>(EMPTY_STATS);


  const { active: activeProject } = useProjects();
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [isProjectsOpen, setIsProjectsOpen] = useState(false);
  const [isPinned, setIsPinned] = useState(true);
  const [widgetSize, setWidgetSize] = useState<'compact' | 'medium' | 'full'>('compact');
  const [isThinking, setIsThinking] = useState(false);
  useEffect(() => presence.setThinking(isThinking), [isThinking]);
  const [thinkingContent, setThinkingContent] = useState('');
  // Real history loads from the gateway on connect; no canned placeholder conversation.
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  // Synchronize responsive widget size with window dimensions (throttled + debounced)
  useEffect(() => {
    let rafId: number | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let blurTimer: ReturnType<typeof setTimeout> | null = null;

    const handleResize = () => {
      // Temporarily disable backdrop-filter blur during active resize
      const root = document.querySelector('.hud-root-container');
      if (root) root.classList.add('resizing');
      if (blurTimer) clearTimeout(blurTimer);
      blurTimer = setTimeout(() => {
        if (root) root.classList.remove('resizing');
      }, 200);

      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        const w = window.innerWidth;
        const newSize = w <= 680 ? 'compact' : w <= 1350 ? 'medium' : 'full';

        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          setWidgetSize((prev) => (prev !== newSize ? newSize : prev));
        }, 150);
      });
    };

    // Set initial size immediately (no debounce)
    const w = window.innerWidth;
    setWidgetSize(w <= 680 ? 'compact' : w <= 1350 ? 'medium' : 'full');

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      if (rafId) cancelAnimationFrame(rafId);
      if (debounceTimer) clearTimeout(debounceTimer);
      if (blurTimer) clearTimeout(blurTimer);
    };
  }, []);

  // Listen for speech synthesis and voice recognition state changes
  useEffect(() => {
    const unsubSpeaking = speechService.onSpeakingChange((speaking) => {
      setIsSpeaking(speaking);
    });
    const unsubListening = speechService.onListeningChange((listening) => {
      setIsListening(listening);
    });
    return () => {
      unsubSpeaking();
      unsubListening();
    };
  }, []);

  const fetchSessionsList = useCallback(async () => {
    try {
      const list = await gateway.listSessions({
        limit: 30,
        includeDerivedTitles: true,
        includeLastMessage: true,
      });
      if (list && list.length > 0) {
        setSessionsList(list);
      }
    } catch (e) {
      console.warn('Failed to fetch sessions list:', e);
    }
  }, []);

  // Her daily review found something: tell Sir, gently, once.
  useEffect(
    () =>
      gateway.onEvolution((e) => {
        const at = Date.now();
        setMessages((prev) => [...prev, { id: `svc_${at}_evo`, role: 'system', text: `${e.summary} Open AGI EVO to review.`, timestamp: at }]);
        speechService.speak("Boss, when you have a minute, I found a way to do better. It's waiting in Evolution for your OK.");
      }),
    [],
  );

  // Self-repair notices from the app: say plainly when something broke and whether it's fixed.
  useEffect(() => {
    const label = { brain: 'reasoning engine', gateway: 'gateway' } as const;
    return window.electronAPI?.onServiceEvent?.((e) => {
      const name = label[e.service];
      const text =
        e.state === 'down'
          ? `My ${name} stopped responding. Restarting it…`
          : e.state === 'restored'
            ? `My ${name} is back${e.ms ? ` (restarted in ${(e.ms / 1000).toFixed(0)} s)` : ''}.`
            : `I couldn't restart my ${name}${e.error ? `: ${e.error}` : ''}. Press INITIALIZE to try again.`;
      setMessages((prev) => [...prev, { id: `svc_${e.at}_${e.state}`, role: 'system', text, timestamp: e.at }]);
      if (e.state === 'restored') speechService.speak(`I had a hiccup with my ${name}, Sir. I'm back.`);
      if (e.state === 'failed') speechService.speak(`Sir, my ${name} is down and I couldn't restart it.`);
    });
  }, []);

  // Check initial Gateway state and connect
  useEffect(() => {
    const checkGatewayStatus = async () => {
      if (window.electronAPI?.getGatewayInfo) {
        try {
          const info = await window.electronAPI.getGatewayInfo();
          if (info.token) gateway.setCredentials(`ws://127.0.0.1:${info.port}`, info.token);
          if (info.running) {
            setShowStartupScreen(false);
            gateway.connect();
            // Already running from earlier: just load the voice models for this window.
            void window.electronAPI?.bootStep?.('voice').then(() => speechService.prepareFillers());
          } else {
            setShowStartupScreen(true);
            gateway.disconnect();
          }
        } catch (e) {
          setShowStartupScreen(true);
        }
      } else {
        gateway.connect();
      }
    };

    checkGatewayStatus();

    // A dropped link (sleep, network blip, gateway restart) must not replace the chat with the boot
    // screen. Only show it when the app says the gateway process itself is not running.
    let offlineTimer: ReturnType<typeof setTimeout> | null = null;
    const unsubStatus = gateway.onStatus((connected) => {
      setIsGatewayConnected(connected);
      if (offlineTimer) clearTimeout(offlineTimer);
      offlineTimer = null;
      if (connected) {
        setShowStartupScreen(false);
        // Once per launch: a real catch-up (what came due or happened while FRIDAY was off),
        // spoken and listed in the chat. Falls back to a plain greeting if it can't be built.
        if (!hasGreetedRef.current) {
          hasGreetedRef.current = true;
          const timeout = new Promise<null>((r) => setTimeout(() => r(null), 15000));
          Promise.race([
            gateway.request<{ spoken: string; text: string; items: unknown[] }>('brief.catchup', {}).catch(() => null),
            timeout,
          ]).then((brief) => {
            if (!brief?.spoken) {
              speechService.speak(speechService.getCinematicGreeting('Boss'));
              return;
            }
            speechService.speak(brief.spoken);
            if (brief.items.length) {
              setIsChatOpen(true); // so the full list is visible, not just spoken
              setMessages((prev) => [
                ...prev,
                { id: 'brief_' + Date.now(), role: 'assistant', text: brief.text, timestamp: Date.now() },
              ]);
            }
          });
        }
        // Load initial history & session catalog
        fetchSessionsList();
        const key = sessionKeyRef.current;
        gateway.getChatHistory(30, key).then((hist) => {
          // The user may have switched session while this loaded; never paint the wrong one.
          if (key !== sessionKeyRef.current) return;
          // Merge, never replace: a message just sent or a reply still streaming must survive.
          setMessages((prev) => mergeHistory(hist, prev));
        });
      } else if (window.electronAPI?.getGatewayInfo) {
        offlineTimer = setTimeout(async () => {
          if (gateway.connected) return;
          const info = await window.electronAPI?.getGatewayInfo?.().catch(() => null);
          if (info && !info.running) setShowStartupScreen(true);
        }, 8000);
      }
    });

    const unsubActivity = gateway.onActivity((_activity, allActivities) => {
      setLiveActivities(allActivities);
      liveActivitiesRef.current = allActivities;
      presence.setActivities(allActivities);
    });

    const unsubMsg = gateway.onMessage((rawText, thinking, isDone, toolCalls, runId) => {
      // The silent marker of background runs (memory flush etc.), even half-streamed, is never shown or said.
      const text = /^\s*N(O(_(R(E(P(L(Y)?)?)?)?)?)?)?\s*$/.test(rawText) ? '' : stripReplyTags(rawText);
      // Another run finishing (heartbeat, a cron job) must not end Sir's pending turn.
      const endsMyTurn = isDone && (!runId || gateway.pendingRunId === null);
      if (thinking) {
        setThinkingContent((prev) => {
          const next = prev ? prev + '\n' + thinking : thinking;
          thinkingContentRef.current = next;
          return next;
        });
      }
      // Speak while the reply streams (sentence by sentence), not after it finishes.
      if (text && gateway.pendingRunId && (!runId || runId === gateway.pendingRunId)) narrateReplyStarted();
      if (text) speechService.feedStream(text, Boolean(isDone));
      else if (isDone) speechService.endStream();
      if (text) {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          const activeTools =
            toolCalls && toolCalls.length > 0
              ? toolCalls
              : liveActivitiesRef.current
                  .filter((a) => a.type === 'action' && a.toolCall)
                  .map((a) => a.toolCall!);
          const activities = [...liveActivitiesRef.current];

          if (last && last.role === 'assistant' && last.id.startsWith('streaming-')) {
            return [
              ...prev.slice(0, -1),
              {
                ...last,
                text,
                thinking: thinkingContentRef.current,
                toolCalls: activeTools.length > 0 ? activeTools : last.toolCalls,
                activities: activities.length > 0 ? activities : last.activities,
              },
            ];
          }
          return [
            ...prev,
            {
              id: 'streaming-' + Date.now(),
              role: 'assistant',
              text,
              thinking: thinkingContentRef.current,
              toolCalls: activeTools.length > 0 ? activeTools : undefined,
              activities: activities.length > 0 ? activities : undefined,
              timestamp: Date.now(),
            },
          ];
        });
      }
      if (endsMyTurn) {
        narrateTurnEnd();
        setIsThinking(false);
      }
      // Any finished run seals its streamed message, so the next reply starts a new bubble.
      if (isDone) {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.role === 'assistant' && last.id.startsWith('streaming-')) {
            const activeTools = liveActivitiesRef.current
              .filter((a) => a.type === 'action' && a.toolCall)
              .map((a) => a.toolCall!);
            return [
              ...prev.slice(0, -1),
              {
                ...last,
                id: 'asst_' + Date.now(),
                toolCalls: activeTools.length > 0 ? activeTools : last.toolCalls,
                activities:
                  liveActivitiesRef.current.length > 0
                    ? [...liveActivitiesRef.current]
                    : last.activities,
              },
            ];
          }
          return prev;
        });
      }
    });

    // Adaptive system telemetry polling
    const pollStats = async () => {
      const stats = await fetchSystemStats();
      setSystemStats(stats);
    };
    pollStats();

    let intervalMs = document.hidden ? 10000 : 3500;
    let statsTimer = setInterval(pollStats, intervalMs);

    const onVisibility = () => {
      clearInterval(statsTimer);
      intervalMs = document.hidden ? 10000 : 3500;
      statsTimer = setInterval(pollStats, intervalMs);
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      if (offlineTimer) clearTimeout(offlineTimer);
      unsubStatus();
      unsubMsg();
      unsubActivity();
      clearInterval(statsTimer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const handleSelectSession = useCallback(async (key: string) => {
    setCurrentSessionKey(key);
    sessionKeyRef.current = key;
    setIsThinking(false);
    setThinkingContent('');
    thinkingContentRef.current = '';
    setLiveActivities([]);
    liveActivitiesRef.current = [];
    gateway.clearCurrentActivities();

    try {
      const hist = await gateway.getChatHistory(50, key);
      if (key !== sessionKeyRef.current) return; // a newer switch won
      if (hist.length > 0) {
        setMessages(hist);
      } else {
        setMessages([
          {
            id: 'init-switched-' + Date.now(),
            role: 'assistant',
            text: `Switched to session ${key}. No earlier messages in it yet.`,
            timestamp: Date.now(),
          },
        ]);
      }
      fetchSessionsList();
    } catch (e) {
      console.warn('Failed to load session history:', e);
    }
  }, [fetchSessionsList]);

  const handleNewSession = useCallback(async () => {
    try {
      await gateway.resetSession(currentSessionKey);
    } catch (e) {
      console.warn('Reset session fallback:', e);
    }
    setIsThinking(false);
    setThinkingContent('');
    thinkingContentRef.current = '';
    setLiveActivities([]);
    liveActivitiesRef.current = [];
    gateway.clearCurrentActivities();
    setMessages([
      {
        id: 'init-new-' + Date.now(),
        role: 'assistant',
        text: 'New session started. What shall we work on, Boss?',
        timestamp: Date.now(),
      },
    ]);
    fetchSessionsList();
  }, [currentSessionKey, fetchSessionsList]);

  const lastSentRef = useRef<{ text: string; at: number } | null>(null);
  const handleSendMessage = useCallback(async (text: string, attachments: Attachment[] = []) => {
    // Same text re-sent while FRIDAY is still on it (impatience, or a voice double-fire):
    // don't queue a second identical run behind the first.
    const normalized = text.trim().toLowerCase();
    if (
      attachments.length === 0 &&
      gateway.pendingRunId &&
      lastSentRef.current?.text === normalized &&
      Date.now() - lastSentRef.current.at < 5 * 60_000
    ) {
      return;
    }
    lastSentRef.current = { text: normalized, at: Date.now() };
    speechService.beginStream();
    narrateTurnStart(text);
    const outgoing = composeMessage(text, attachments);
    const attachedNames = attachments.map((a) => `📎 ${a.fileName}`).join('\n');
    const userMsg: ChatMessage = {
      id: 'usr_' + Date.now(),
      role: 'user',
      text: attachedNames ? `${text}${text ? '\n' : ''}${attachedNames}` : text,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...sealStreaming(prev), userMsg]);
    setIsThinking(true);
    setThinkingContent('');
    thinkingContentRef.current = '';
    setLiveActivities([]);
    liveActivitiesRef.current = [];
    gateway.clearCurrentActivities();

    // If on home in full/med size, open drawer; if in chat tab, keeps in place
    if ((activeTab === 'home' || activeTab === 'avatar') && widgetSize !== 'compact') {
      setIsChatOpen(true);
    }

    try {
      await gateway.sendMessage(outgoing, currentSessionKey, toGatewayAttachments(attachments));
      setTimeout(fetchSessionsList, 1500);
    } catch (e) {
      // Say so plainly: nothing was executed if the gateway never received the message.
      console.warn('Gateway message dispatch failed:', e);
      setIsThinking(false);
      setMessages((prev) => [
        ...prev,
        {
          id: 'asst_' + Date.now(),
          role: 'assistant',
          text: "I couldn't reach the gateway, so that message wasn't sent and nothing was run. Check that the gateway is up and try again.",
          timestamp: Date.now(),
        },
      ]);
    }
  }, [activeTab, widgetSize, currentSessionKey, fetchSessionsList]);

  // Voice: wake word, Ctrl+Alt+Space, mic button and barge-in all go through the voice loop.
  const sendRef = useRef(handleSendMessage);
  sendRef.current = handleSendMessage;
  const busyRef = useRef(false);
  busyRef.current = isThinking || liveActivities.some((a) => a.status === 'running');
  // FRIDAY says short progress lines while long tools run.
  useEffect(() => startNarration(), []);

  useEffect(
    () =>
      voiceLoop.attach({
        send: (t) => sendRef.current(t),
        isBusy: () => busyRef.current,
        abort: () => {
          gateway.abortChat(sessionKeyRef.current).catch((e) => console.warn('Abort failed:', e));
        },
      }),
    [],
  );

  const handleSelectTab = useCallback((tab: NavItem) => {
    setActiveTab(tab);
    if (tab === 'avatar') setAvatarOk(Boolean(window.electronAPI?.loadAvatar));
    if (tab === 'chat') {
      setIsChatOpen(false); // will render in main stage
    }
  }, []);

  const handleMinimize = useCallback(() => {
    window.electronAPI?.minimizeWindow?.();
  }, []);

  const handleClose = useCallback(() => {
    window.electronAPI?.closeWindow?.();
  }, []);

  const handleSetSize = useCallback(async (size: 'compact' | 'medium' | 'full') => {
    setWidgetSize(size);
    if (size === 'compact') {
      await window.electronAPI?.setSize?.(560, 720);
    } else if (size === 'medium') {
      await window.electronAPI?.setSize?.(1150, 740);
    } else {
      await window.electronAPI?.setSize?.(1920, 1080);
    }
  }, []);

  const handleTogglePin = useCallback(async () => {
    setIsPinned((prev) => {
      const nextPin = !prev;
      if (window.electronAPI?.setDesktopMode) {
        window.electronAPI.setDesktopMode(nextPin);
      } else if (window.electronAPI?.setAlwaysOnTop) {
        window.electronAPI.setAlwaysOnTop(nextPin);
      }
      return nextPin;
    });
  }, []);

  const refreshHistory = async () => {
    try {
      const hist = await gateway.getChatHistory(40, currentSessionKey);
      if (hist.length > 0) setMessages(hist);
      fetchSessionsList();
    } catch (e) {}
  };

  return (
    <div
      className={`relative w-screen h-screen overflow-hidden flex flex-col text-slate-100 select-none hud-root-container hud-skeuo ${window.electronAPI ? 'sk-no-backdrop' : ''} ${
        widgetSize === 'full' ? 'rounded-none border-0' : 'rounded-2xl'
      }`}
    >
      {/* No top bar or sidebar: FRIDAY icon (home + sections) and quiet window controls */}
      <HudChrome
        activeTab={activeTab}
        onSelectTab={handleSelectTab}
        currentSize={widgetSize}
        onSetSize={handleSetSize}
        isPinned={isPinned}
        onTogglePin={handleTogglePin}
        isVoiceMuted={isVoiceMuted}
        onToggleVoice={() => setIsVoiceMuted(speechService.toggleMute())}
        isSpeaking={isSpeaking}
        onMinimize={handleMinimize}
        onClose={handleClose}
        connected={isGatewayConnected}
      />

      {!isGatewayConnected && !showStartupScreen && !startupRunning && (
        <div
          role="status"
          className="relative z-20 flex items-center justify-center gap-2 py-1 text-[11px] tracking-wide text-amber-200 bg-amber-500/10 border-b border-amber-400/20"
        >
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-300 animate-pulse" />
          Reconnecting to FRIDAY... your messages are safe and will send when the link is back.
        </div>
      )}

      {/* Center Main Stage Area */}
      <div className="flex-1 flex overflow-hidden relative z-10 pt-14">
        {/* If Offline & Startup Screen requested */}
        {(showStartupScreen && !isGatewayConnected) || startupRunning ? (
          <StartupArcReactor
            onBootingChange={setStartupRunning}
            onStarted={() => {
              setShowStartupScreen(false);
              gateway.connect();
              void window.electronAPI?.bootStep?.('voice').then(() => speechService.prepareFillers());
            }}
          />
        ) : (
          <>

            {/* COMPACT DESK WIDGET MODE */}
            {widgetSize === 'compact' ? (
              <div className="flex-1 flex flex-col items-center justify-between p-3.5 overflow-hidden">
                {/* Quick Mini Telemetry Bar */}
                <div className="flex items-center justify-between w-full px-3.5 py-2 rounded-xl hud-glass-panel text-[11px] font-mono text-cyan-300/90">
                  <span className="font-bold font-hud text-slate-200">BALARAJ AGI</span>
                  <span className="font-bold font-hud text-slate-200">FRIDAY AI</span>
                  <span>CPU: {systemStats.cpu ?? '—'}{systemStats.cpu != null ? '%' : ''}</span>
                  <span>RAM: {systemStats.ram ?? '—'}{systemStats.ram != null ? '%' : ''}</span>
                  <span className={isGatewayConnected ? 'text-emerald-400' : 'text-amber-400'}>
                    {isGatewayConnected ? '● ONLINE' : '● CONNECTING'}
                  </span>
                </div>

                {/* Arc Reactor Center + Floating LiveActivity */}
                <div className="relative flex-1 min-h-0 flex items-center justify-center w-full py-0.5">
                  <div className="w-full h-full flex items-center justify-center scale-90">
                    <ArcReactorCore
                      isThinking={isThinking}
                      isSpeaking={isSpeaking}
                      isListening={isListening}
                      statusText={
                        isSpeaking
                          ? 'ANSWERING // TRANSMITTING...'
                          : isThinking
                          ? 'THINKING // NEURAL SYNTHESIS...'
                          : isListening
                          ? 'LISTENING // AUDIO RECEPTORS...'
                          : isGatewayConnected
                          ? 'STANDBY // MONITORING...'
                          : 'CONNECTING...'
                      }
                      onSelectTag={(tag) => handleSendMessage(`FRIDAY, status on ${tag.toLowerCase()}`)}
                    />
                  </div>
                  <div className="absolute bottom-1 left-0 right-0 z-20 px-1 pointer-events-none">
                    <LiveActivity compact />
                  </div>
                </div>

                {/* Real-Time Browser / Focus Media Bar */}
                <div className="w-full my-1">
                  <FocusMediaPlayer compact={true} />
                </div>

                {/* Bottom Command Pill & Quick Actions */}
                <div className="w-full flex flex-col gap-2 pb-1">
                  <CommandBar
                    onSendMessage={handleSendMessage}
                  />
                  <div className="flex items-center justify-center gap-1.5 flex-wrap">
                    {['Brief me', 'Check WhatsApp', activeProject ? `${activeProject.name} status` : 'Project status', 'Diagnose'].map((label, idx) => (
                      <button
                        key={idx}
                        onClick={() => handleSendMessage(`FRIDAY, ${label.toLowerCase()}`)}
                        className="px-2.5 py-1 rounded-lg text-[10px] font-hud hud-glass-pill text-cyan-300 hover:text-cyan-100 cursor-pointer"
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              /* TABBED EXPANDED MODES (MEDIUM / FULL) */
              <div className="flex-1 flex overflow-hidden">
                {activeTab === 'home' && (
                  <div className={`sk-home ${isChatOpen ? 'sk-home-chat' : ''}`}>
                    {/* Left column: greeting, meters (stretch), media */}
                    <div className="sk-col sk-col-left">
                      <GreetingCard
                        userName="Balaraj"
                        onActionClick={(prompt) => handleSendMessage(prompt)}
                      />
                      <SystemStatusCard stats={systemStats} />
                      <FocusMediaPlayer />
                    </div>

                    {/* Center column: reactor (fills), command bar aligned with the side columns' bottoms */}
                    <div className="sk-col sk-col-center">
                      <div className="relative flex-1 min-h-0 flex items-center justify-center w-full">
                        <ArcReactorCore
                          isThinking={isThinking}
                          isSpeaking={isSpeaking}
                          isListening={isListening}
                          statusText={
                            isSpeaking
                              ? 'ANSWERING // TRANSMITTING...'
                              : isThinking
                              ? 'THINKING // NEURAL SYNTHESIS...'
                              : isListening
                              ? 'LISTENING // AUDIO RECEPTORS...'
                              : isGatewayConnected
                              ? 'STANDBY // MONITORING...'
                              : 'CONNECTING...'
                          }
                          onSelectTag={(tag) => handleSendMessage(`FRIDAY, focus on ${tag.toLowerCase()}`)}
                          headerPlacement="top"
                        />
                        <div className="absolute bottom-1 left-0 right-0 z-20 px-2 pointer-events-none">
                          <LiveActivity />
                        </div>
                      </div>

                      <div className="w-full flex-shrink-0">
                        <CommandBar
                          onSendMessage={handleSendMessage}
                        />
                      </div>
                    </div>

                    {/* Right Column */}
                    {!isChatOpen && (
                      <div className="sk-col sk-col-right">
                        <AgendaCard />
                        <ActiveProjectCard onChangeProject={() => setIsProjectsOpen(true)} />
                        <HolographicGlobe />
                      </div>
                    )}
                  </div>
                )}

                {activeTab === 'avatar' && (
                  <div className="flex-1 min-w-0 flex flex-col gap-3 p-4 overflow-hidden">
                    <div className="relative flex-1 min-h-0">
                      {avatarOk ? (
                        <AvatarStage onUnavailable={() => setAvatarOk(false)} />
                      ) : (
                        <div className="h-full flex items-center justify-center text-center text-sm font-mono text-slate-400">
                          No character yet. Put a .vrm file at ~/.friday/avatar/friday.vrm and reopen this tab.
                        </div>
                      )}
                      <div className="absolute bottom-2 left-0 right-0 z-20 px-2 pointer-events-none">
                        <LiveActivity />
                      </div>
                    </div>
                    <div className="flex-shrink-0">
                      <CommandBar onSendMessage={handleSendMessage} />
                    </div>
                  </div>
                )}

                {activeTab === 'chat' && (
                  <ChatPanel
                    messages={messages}
                    onSendMessage={handleSendMessage}
                    isThinking={isThinking}
                    thinkingContent={thinkingContent}
                    liveActivities={liveActivities}
                    onRefreshHistory={refreshHistory}
                    currentSessionKey={currentSessionKey}
                    sessions={sessionsList}
                    onSelectSession={handleSelectSession}
                    onNewSession={handleNewSession}
                  />
                )}

                {activeTab === 'workspace' && <WorkspacePanel />}

                {activeTab === 'channels' && <ChannelsPanel />}

                {activeTab === 'skills' && <SkillsPanel />}
                
                {activeTab === 'abilities' && <AbilitiesPanel />}
                {activeTab === 'evolution' && <EvolutionPanel />}

                {activeTab === 'opportunities' && <OpportunityPanel />}

                {activeTab === 'cron' && <CronPanel />}

                {activeTab === 'approvals' && <ApprovalsPanel />}

                {activeTab === 'logs' && <LogsPanel />}

                {activeTab === 'settings' && <ConfigSettingsPanel />}
              </div>
            )}
          </>
        )}

        {/* Chat dock: sits beside the content, under the header, so it never covers anything */}
        <ChatDrawer
          isOpen={isChatOpen}
          onClose={() => setIsChatOpen(false)}
          messages={messages}
          onSendMessage={handleSendMessage}
          isThinking={isThinking}
          thinkingContent={thinkingContent}
          liveActivities={liveActivities}
          currentSessionKey={currentSessionKey}
          sessions={sessionsList}
          onSelectSession={handleSelectSession}
          onNewSession={handleNewSession}
        />
      </div>

      {/* Bottom Right Resize Grip */}
      <div className="absolute bottom-1 right-1 pointer-events-none opacity-40">
        <svg className="w-3 h-3 text-cyan-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="21" y1="21" x2="14" y2="21" />
          <line x1="21" y1="21" x2="21" y2="14" />
          <line x1="21" y1="17" x2="17" y2="21" />
        </svg>
      </div>


      {/* Projects Modal */}
      <ProjectsModal
        isOpen={isProjectsOpen}
        onClose={() => setIsProjectsOpen(false)}
      />
    </div>
  );
};

export default App;
