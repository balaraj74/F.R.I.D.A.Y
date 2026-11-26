const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getSystemStats: () => ipcRenderer.invoke('system:get-stats'),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  setAlwaysOnTop: (flag) => ipcRenderer.invoke('window:set-always-on-top', flag),
  setSize: (width, height) => ipcRenderer.invoke('window:set-size', { width, height }),
  getSize: () => ipcRenderer.invoke('window:get-size'),
  setDesktopMode: (isDesktop) => ipcRenderer.invoke('window:set-desktop-mode', isDesktop),
  getGatewayInfo: () => ipcRenderer.invoke('gateway:get-info'),
  startGateway: () => ipcRenderer.invoke('gateway:start'),
  pickFolder: () => ipcRenderer.invoke('abilities:pick-folder'),
  openAutomationEditor: () => ipcRenderer.invoke('abilities:open-editor'),
  bootStep: (step) => ipcRenderer.invoke('boot:step', step),
  onServiceEvent: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('friday:service-event', handler);
    return () => ipcRenderer.removeListener('friday:service-event', handler);
  },
  stopGateway: () => ipcRenderer.invoke('gateway:stop'),
  getMediaStatus: () => ipcRenderer.invoke('media:get-status'),
  mediaPlayPause: () => ipcRenderer.invoke('media:play-pause'),
  mediaNext: () => ipcRenderer.invoke('media:next'),
  mediaPrevious: () => ipcRenderer.invoke('media:previous'),
  synthesizeSpeech: (text, voice) => ipcRenderer.invoke('voice:synthesize-speech', { text, voice }),
  cancelSpeech: () => ipcRenderer.invoke('voice:cancel'),
  transcribeAudio: (base64Audio, mimeType) => ipcRenderer.invoke('voice:transcribe-audio', { base64Audio, mimeType }),
  getVoiceEndpoint: () => ipcRenderer.invoke('voice:endpoint'),
  loadAvatar: () => ipcRenderer.invoke('avatar:load'),
  // Wake word / push-to-talk / live transcript events from the main process.
  onVoiceCommand: (cb) => {
    const handler = (_event, cmd) => cb(cmd);
    ipcRenderer.on('voice:command', handler);
    return () => ipcRenderer.removeListener('voice:command', handler);
  },
  setVoiceState: (state) => ipcRenderer.send('voice:state', state),
  getAutonomy: () => ipcRenderer.invoke('autonomy:get'),
  listProjects: () => ipcRenderer.invoke('projects:list'),
  setAutonomy: (paused) => ipcRenderer.invoke('autonomy:set', paused),
  getAgenda: () => ipcRenderer.invoke('assistant:get-agenda'),
  planDay: () => ipcRenderer.invoke('assistant:plan-day'),
  getWorkspaceStatus: () => ipcRenderer.invoke('assistant:get-workspace-status'),
  loginGoogle: () => ipcRenderer.invoke('assistant:login-google'),
  getAuthUrl: () => ipcRenderer.invoke('assistant:get-auth-url'),
  setDirectAuth: (email, appPassword, calendarUrl) =>
    ipcRenderer.invoke('assistant:set-direct-auth', { email, appPassword, calendarUrl }),
  getUnreadEmails: () => ipcRenderer.invoke('assistant:get-unread-emails'),
  getEvents: () => ipcRenderer.invoke('assistant:get-events'),
  listDriveFiles: (maxResults) => ipcRenderer.invoke('workspace:list-drive-files', maxResults),
  searchDrive: (query, maxResults) => ipcRenderer.invoke('workspace:search-drive', query, maxResults),
  createDoc: (title, content) => ipcRenderer.invoke('workspace:create-doc', title, content),
  readDoc: (docId) => ipcRenderer.invoke('workspace:read-doc', docId),
  createSheet: (title) => ipcRenderer.invoke('workspace:create-sheet', title),
  getTasks: () => ipcRenderer.invoke('workspace:get-tasks'),
  createTask: (title, notes) => ipcRenderer.invoke('workspace:create-task', title, notes),
  completeTask: (taskId) => ipcRenderer.invoke('workspace:complete-task', taskId),
  openWorkspaceApp: (app) => ipcRenderer.invoke('workspace:open-app', app),
  setOAuthClient: (clientId, clientSecret) => ipcRenderer.invoke('workspace:set-client-credentials', clientId, clientSecret),
  queryMemory: (query) => ipcRenderer.invoke('memory:query', query),

  // Tier 1: OS Controller
  osExec: (params) => ipcRenderer.invoke('os:exec-command', params),
  osReadFile: (params) => ipcRenderer.invoke('os:read-file', params),
  osWriteFile: (params) => ipcRenderer.invoke('os:write-file', params),
  osListDir: (params) => ipcRenderer.invoke('os:list-dir', params),
  osDeletePath: (params) => ipcRenderer.invoke('os:delete-path', params),
  osClipboardRead: () => ipcRenderer.invoke('os:clipboard-read'),
  osClipboardWrite: (text) => ipcRenderer.invoke('os:clipboard-write', text),
  osScreenshot: (params) => ipcRenderer.invoke('os:screenshot', params),
  osTypeText: (params) => ipcRenderer.invoke('os:type-text', params),
  osPressKey: (key) => ipcRenderer.invoke('os:press-key', key),
  osOpenApp: (app) => ipcRenderer.invoke('os:open-app', app),
  osListWindows: () => ipcRenderer.invoke('os:list-windows'),
  osFocusWindow: (query) => ipcRenderer.invoke('os:focus-window', query),
  osNotify: (params) => ipcRenderer.invoke('os:notify', params),

  // Tier 2: Browser Engine
  browserNavigate: (url) => ipcRenderer.invoke('browser:navigate', url),
  browserSearch: (query, maxResults) => ipcRenderer.invoke('browser:search', query, maxResults),
  browserExtract: (url, maxChars) => ipcRenderer.invoke('browser:extract', url, maxChars),
  browserScreenshot: (url, outPath) => ipcRenderer.invoke('browser:screenshot', url, outPath),

  // Autonomous Opportunities & Work Engine
  opportunityScan: () => ipcRenderer.invoke('opportunity:scan'),
  opportunityList: (status, limit) => ipcRenderer.invoke('opportunity:list', status, limit),
  opportunityPrepare: (id) => ipcRenderer.invoke('opportunity:prepare', id),
  opportunityGetWorkspace: (id) => ipcRenderer.invoke('opportunity:get-workspace', id),
  opportunityOpenWorkspace: (id, app) => ipcRenderer.invoke('opportunity:open-workspace', id, app),
  opportunitySolve: (id) => ipcRenderer.invoke('opportunity:solve', id),
  opportunityStage: (params) => ipcRenderer.invoke('opportunity:stage', params),
  opportunityApprove: (id) => ipcRenderer.invoke('opportunity:approve', id),
  opportunityComplete: (id, earned) => ipcRenderer.invoke('opportunity:complete', id, earned),
  opportunityStats: () => ipcRenderer.invoke('opportunity:stats'),

  // Pictures FRIDAY generated
  readMedia: (file) => ipcRenderer.invoke('media:read', file),
  revealMedia: (file) => ipcRenderer.invoke('media:reveal', file),
  saveMediaAs: (file) => ipcRenderer.invoke('media:save-as', file),

  // Tier 3: Communication
  sendEmail: (params) => ipcRenderer.invoke('comms:send-email', params),
  createCalendarEvent: (params) => ipcRenderer.invoke('comms:create-event', params),
  sendDesktopNotify: (params) => ipcRenderer.invoke('comms:notify', params),

  // Tier 4: Dev Tools
  gitStatus: (path) => ipcRenderer.invoke('dev:git-status', path),
  gitCommit: (params) => ipcRenderer.invoke('dev:git-commit', params),
  gitLog: (path, count) => ipcRenderer.invoke('dev:git-log', path, count),
  dockerStatus: () => ipcRenderer.invoke('dev:docker-status'),
  runTests: (params) => ipcRenderer.invoke('dev:run-tests', params),

  // Tier 5: Knowledge Engine
  knowledgeSearch: (query, maxResults) => ipcRenderer.invoke('knowledge:search', query, maxResults),
  knowledgeArxiv: (query, maxResults) => ipcRenderer.invoke('knowledge:arxiv', query, maxResults),
  knowledgeAnalyzePdf: (path, maxPages) => ipcRenderer.invoke('knowledge:analyze-pdf', path, maxPages),
});
