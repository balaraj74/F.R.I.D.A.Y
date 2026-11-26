/** Live machine stats; null means "couldn't measure" and is shown as "—". */
export interface SystemStats {
  cpu: number | null;
  ram: number | null;
  disk: number | null;
  gpu: number | null;
  battery: number | null;
  uptime: number;
  platform: string;
  hostname: string;
  loadAvg: number;
}

export interface AgendaItem {
  id: string;
  time: string;
  title: string;
  completed: boolean;
  active?: boolean;
}

export interface ProjectInfo {
  id: string;
  name: string;
  tagline: string;
  progress: number;
  category: string;
  status: 'active' | 'completed' | 'queued';
  tech: string[];
}

export interface WorldClock {
  city: string;
  timezone: string;
  offsetHours: number;
  highlight?: boolean;
}

/** Events from the Electron main process: wake word, push-to-talk, live transcript. */
export type VoiceCommand =
  | { type: 'wake' }
  | { type: 'ptt' }
  | { type: 'cancel' }
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string };

export interface ToolCallStep {
  id: string;
  name: string;
  input?: any;
  result?: string;
  isError?: boolean;
  status: 'running' | 'completed' | 'error';
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
}

export interface ActivityStep {
  id: string;
  type: 'thinking' | 'action' | 'text';
  title: string;
  content?: string;
  toolCall?: ToolCallStep;
  timestamp: number;
  status: 'running' | 'completed' | 'error';
  durationMs?: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  thinking?: string;
  toolCalls?: ToolCallStep[];
  activities?: ActivityStep[];
  timestamp: number;
}

export interface SessionItem {
  key: string;
  sessionId?: string;
  displayName?: string;
  label?: string;
  channel?: string;
  chatType?: string;
  updatedAt?: number;
  derivedTitle?: string;
  lastMessagePreview?: string;
  model?: string;
  totalTokens?: number;
  abortedLastRun?: boolean;
}

export interface ChannelWhatsApp {
  configured: boolean;
  linked: boolean;
  running: boolean;
  connected: boolean;
  self?: {
    e164: string;
    jid: string;
  };
  authAgeMs?: number;
  lastConnectedAt?: number | null;
  dmPolicy?: string;
  allowFrom?: string[];
  reconnectAttempts?: number;
}

export interface ChannelDiscord {
  configured: boolean;
  running: boolean;
  tokenSource?: string;
  lastError?: string | null;
}

export interface ChannelGoogleChat {
  configured: boolean;
  running: boolean;
  lastError?: string | null;
}

export interface ChannelsStatus {
  ts: number;
  channels: {
    whatsapp?: ChannelWhatsApp;
    discord?: ChannelDiscord;
    googlechat?: ChannelGoogleChat;
    [key: string]: any;
  };
  channelOrder: string[];
  channelSummary?: string[];
}

export interface SkillItem {
  name: string;
  description?: string;
  source?: string;
  enabled?: boolean;
  category?: string;
}

export interface CronJobItem {
  id: string;
  name: string;
  enabled: boolean;
  schedule: {
    kind: string;
    everyMs?: number;
    expr?: string;
    tz?: string;
  };
  payload?: {
    kind: string;
    message?: string;
    model?: string;
  };
  state?: {
    nextRunAtMs?: number;
    lastRunAtMs?: number;
    lastStatus?: string;
    lastError?: string;
  };
}

export interface ExecApprovalRequest {
  id: string;
  agentId?: string;
  command?: string;
  toolName?: string;
  args?: any;
  requestedAt?: number;
  status: 'pending' | 'allowed' | 'denied';
}

export interface GatewayStatusPayload {
  linkChannel?: {
    id: string;
    label: string;
    linked: boolean;
    authAgeMs?: number;
  };
  channelSummary?: string[];
  sessions?: {
    count: number;
    defaults?: {
      model: string;
      contextTokens: number;
    };
    recent?: {
      agentId: string;
      key: string;
      model?: string;
      contextTokens?: number;
      totalTokens?: number;
      remainingTokens?: number;
      percentUsed?: number;
      inputTokens?: number;
      outputTokens?: number;
    }[];
  };
}

export interface MediaStatus {
  active: boolean;
  isPlaying: boolean;
  player?: string;
  status?: string;
  artist?: string;
  title?: string;
  artUrl?: string;
  position?: number;
  length?: number;
}

export interface DayPlan {
  briefing: string;
  agenda: AgendaItem[];
  emailSummary?: string;
  updatedAt?: string;
  authenticated?: boolean;
}

export interface EvolutionStatus {
  /** false when the evolution service couldn't be reached; numbers are then null. */
  available?: boolean;
  generation: number | null;
  total_mutations: number | null;
  last_evolution?: string;
  status: string;
  active_experiments?: number;
  success_rate?: number | null;
  nodes_count?: number | null;
  edges_count?: number | null;
  episodic_count?: number | null;
  procedural_count?: number;
  evolution_log_path?: string;
}

export interface MemoryQueryResult {
  query: string;
  latency_ms: number;
  matched_nodes: any[];
  associations: any[];
  episodic_context?: any[];
  procedural_playbooks?: any[];
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  webViewLink?: string;
  iconLink?: string;
  size?: string;
}

export interface WorkspaceTask {
  id: string;
  title: string;
  status?: string;
  due?: string;
  notes?: string;
}

export interface WorkspaceStatus {
  authenticated: boolean;
  mode: 'full_oauth' | 'direct_app_password' | 'none';
  email: string | null;
  has_oauth: boolean;
  has_direct_auth: boolean;
  has_custom_client?: boolean;
  capabilities: {
    gmail: boolean;
    calendar: boolean;
    drive: boolean;
    docs: boolean;
    sheets: boolean;
    tasks: boolean;
  };
}

declare global {
  interface Window {
    electronAPI?: {
      getSystemStats: () => Promise<SystemStats>;
      minimizeWindow: () => Promise<void>;
      closeWindow: () => Promise<void>;
      setAlwaysOnTop: (flag: boolean) => Promise<void>;
      setSize: (width: number, height: number) => Promise<void>;
      getSize: () => Promise<{ width: number; height: number }>;
      setDesktopMode: (isDesktop: boolean) => Promise<void>;
      getGatewayInfo: () => Promise<any>;
      startGateway: () => Promise<any>;
      pickFolder?: () => Promise<string | null>;
      readMedia?: (file: string) => Promise<{ ok: boolean; dataUrl?: string; path?: string; error?: string }>;
      revealMedia?: (file: string) => Promise<boolean>;
      saveMediaAs?: (file: string) => Promise<boolean>;
      openAutomationEditor?: () => Promise<boolean>;
      onServiceEvent?: (
        cb: (e: { service: 'brain' | 'gateway'; state: 'down' | 'restored' | 'failed'; error?: string; ms?: number; at: number }) => void,
      ) => () => void;
      bootStep?: (step: 'brain' | 'gateway' | 'voice') => Promise<{
        ok: boolean;
        already?: boolean;
        ms?: number;
        error?: string;
        stt?: boolean;
        tts?: boolean;
        vad?: boolean;
        installed?: { stt: boolean; tts: boolean };
      }>;
      stopGateway: () => Promise<any>;
      getMediaStatus: () => Promise<any>;
      mediaPlayPause: () => Promise<any>;
      mediaNext: () => Promise<any>;
      mediaPrevious: () => Promise<any>;
      synthesizeSpeech: (text: string, voice?: string) => Promise<any>;
      cancelSpeech: () => Promise<any>;
      transcribeAudio: (base64Audio: string, mimeType?: string) => Promise<any>;
      loadAvatar?: () => Promise<Uint8Array | ArrayBuffer | null>;
      getVoiceEndpoint?: () => Promise<{ vadUrl: string | null; stt: boolean; tts: boolean }>;
      onVoiceCommand?: (cb: (cmd: VoiceCommand) => void) => () => void;
      setVoiceState?: (state: { listening: boolean; speaking: boolean }) => void;
      getAutonomy?: () => Promise<{ paused: boolean }>;
      listProjects?: () => Promise<RepoProject[]>;
      setAutonomy?: (paused: boolean) => Promise<{ paused: boolean }>;
      getAgenda: () => Promise<DayPlan>;
      planDay: () => Promise<any>;
      getWorkspaceStatus: () => Promise<WorkspaceStatus>;
      loginGoogle: () => Promise<boolean>;
      getAuthUrl: () => Promise<{ url: string }>;
      setDirectAuth: (
        email: string,
        appPassword: string,
        calendarUrl?: string
      ) => Promise<{ success: boolean; error?: string }>;
      getUnreadEmails: () => Promise<any[]>;
      getEvents: () => Promise<any[]>;
      listDriveFiles: (maxResults?: number) => Promise<DriveFile[]>;
      searchDrive: (query: string, maxResults?: number) => Promise<DriveFile[]>;
      createDoc: (title: string, content?: string) => Promise<any>;
      readDoc: (docId: string) => Promise<any>;
      createSheet: (title: string) => Promise<any>;
      getTasks: () => Promise<WorkspaceTask[]>;
      createTask: (title: string, notes?: string) => Promise<any>;
      completeTask: (taskId: string) => Promise<any>;
      openWorkspaceApp: (app: string) => Promise<any>;
      setOAuthClient: (clientId: string, clientSecret: string) => Promise<{ success: boolean; error?: string }>;
      queryMemory: (query: string) => Promise<MemoryQueryResult>;

      // Tier 1: OS Controller
      osExec: (params: { cmd: string; cwd?: string; timeout?: number }) => Promise<any>;
      osReadFile: (params: { path: string; max_bytes?: number }) => Promise<any>;
      osWriteFile: (params: { path: string; content: string; append?: boolean }) => Promise<any>;
      osListDir: (params?: { path?: string }) => Promise<any>;
      osDeletePath: (params: { path: string }) => Promise<any>;
      osClipboardRead: () => Promise<any>;
      osClipboardWrite: (text: string) => Promise<any>;
      osScreenshot: (params?: { path?: string; window_id?: string }) => Promise<any>;
      osTypeText: (params: { text: string; delay_ms?: number }) => Promise<any>;
      osPressKey: (key: string) => Promise<any>;
      osOpenApp: (app: string) => Promise<any>;
      osListWindows: () => Promise<any>;
      osFocusWindow: (query: string) => Promise<any>;
      osNotify: (params: { title: string; message: string; urgency?: string }) => Promise<any>;

      // Tier 2: Browser Engine
      browserNavigate: (url: string) => Promise<any>;
      browserSearch: (query: string, maxResults?: number) => Promise<any>;
      browserExtract: (url: string, maxChars?: number) => Promise<any>;
      browserScreenshot: (url?: string, outPath?: string) => Promise<any>;

      // Autonomous Opportunity & Work Engine
      opportunityScan: () => Promise<any>;
      opportunityList: (status?: string, limit?: number) => Promise<any>;
      opportunityPrepare: (id: string) => Promise<any>;
      opportunityGetWorkspace: (id: string) => Promise<any>;
      opportunityOpenWorkspace: (id: string, app?: string) => Promise<any>;
      opportunitySolve: (id: string) => Promise<any>;
      opportunityStage: (params: { id: string; summary: string; details: string }) => Promise<any>;
      opportunityApprove: (id: string) => Promise<any>;
      opportunityComplete: (id: string, earned?: number) => Promise<any>;
      opportunityStats: () => Promise<any>;

      // Tier 3: Communication
      sendEmail: (params: { to: string; subject: string; body: string; html?: string }) => Promise<any>;
      createCalendarEvent: (params: { summary: string; start: string; end: string; description?: string }) => Promise<any>;
      sendDesktopNotify: (params: { title: string; message: string; urgency?: string }) => Promise<any>;

      // Tier 4: Dev Tools
      gitStatus: (path?: string) => Promise<any>;
      gitCommit: (params: { path?: string; message: string; files?: string[] }) => Promise<any>;
      gitLog: (path?: string, count?: number) => Promise<any>;
      dockerStatus: () => Promise<any>;
      runTests: (params: { path?: string; framework?: string }) => Promise<any>;

      // Tier 5: Knowledge Engine
      knowledgeSearch: (query: string, maxResults?: number) => Promise<any>;
      knowledgeArxiv: (query: string, maxResults?: number) => Promise<any>;
      knowledgeAnalyzePdf: (path: string, maxPages?: number) => Promise<any>;
    };
  }
}



/** Display helper: never invent a number the backend didn't report. */
export const fmtStat = (n: number | null | undefined): string => (n == null ? '—' : String(n));

/** A real git project found under the home folder (Electron `projects:list`). */
export interface RepoProject {
  path: string;
  name: string;
  description: string;
  branch: string;
  lastCommitAt: number | null;
  lastCommitMessage: string;
  uncommitted: number;
  ahead: number;
  behind: number;
  tech: string[];
}

/** A long job FRIDAY works through in the background (gateway `jobs.list` / `job` events). */
export interface BackgroundJob {
  id: string;
  title: string;
  status: 'planning' | 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';
  steps: { title: string; status: 'pending' | 'running' | 'done' | 'failed'; summary?: string }[];
  question?: string;
  report?: string;
  dir: string;
  updatedAt: string;
}

/** What FRIDAY can do right now (gateway `abilities.status`). */
export interface AbilitiesStatus {
  plugins: { name: string; state: 'connecting' | 'connected' | 'error' | 'disabled'; tools: number; error?: string }[];
  files: { folders: string[]; files: number; chunks: number; lastSync: string | null; syncing: boolean };
  jobs: { active: number; recent: { id: string; title: string; status: string; done: number; total: number }[] };
  code: { id: string; branch: string; repo: string; task: string }[];
  automations: { up: boolean; url: string };
  search: { up: boolean };
  screen: { approved: boolean };
  benchmark: { latest: number | null; previous: number | null; measurements: number };
}
