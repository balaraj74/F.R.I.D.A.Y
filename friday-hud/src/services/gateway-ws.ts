import {
  ChannelsStatus,
  SkillItem,
  CronJobItem,
  ExecApprovalRequest,
  GatewayStatusPayload,
  ChatMessage,
  ToolCallStep,
  ActivityStep,
  SessionItem,
  BackgroundJob,
  AbilitiesStatus,
} from '../types';
import { presence } from './presence';

export interface Thought {
  kind: 'reasoning' | 'recall' | 'lesson';
  text: string;
  outcome?: 'success' | 'failure' | 'partial';
  ts: number;
}

export class FridayGatewayClient {
  private ws: WebSocket | null = null;
  private token: string;
  private url: string;
  private isConnected = false;
  private pending = new Map<
    string,
    { resolve: (val: any) => void; reject: (err: any) => void; timer: ReturnType<typeof setTimeout>; method: string }
  >();
  /** Bumped on every (dis)connect so events from a replaced socket can never touch current state. */
  private gen = 0;
  private wantConnected = false;
  private backoffMs = 1000;
  private lastFrameAt = Date.now();
  /** Last time the current run produced any event (not just a heartbeat reply). */
  private lastRunEventAt = Date.now();
  private lastTickAt = Date.now();
  private pingInFlight = false;
  private recovering = false;
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private messageListeners: ((text: string, thinking?: string, isDone?: boolean, toolCalls?: any[], runId?: string) => void)[] = [];
  /** runId of the message Sir sent most recently (chat events carry it back). */
  pendingRunId: string | null = null;
  private statusListeners: ((connected: boolean) => void)[] = [];
  private approvalListeners: ((approval: ExecApprovalRequest) => void)[] = [];
  private logListeners: ((lines: string[]) => void)[] = [];
  private activityListeners: ((activity: ActivityStep, allActivities: ActivityStep[]) => void)[] = [];
  private currentRunActivities: ActivityStep[] = [];
  private reconnectTimer: number | null = null;
  private pendingApprovalIds = new Set<string>();

  private approvalResolvedListeners: ((id: string) => void)[] = [];

  private trackPendingApproval(id: string, pending: boolean) {
    if (pending) this.pendingApprovalIds.add(id);
    else if (this.pendingApprovalIds.delete(id)) this.approvalResolvedListeners.forEach((cb) => cb(id));
    presence.setAwaitingApproval(this.pendingApprovalIds.size > 0);
  }

  /** An approval was answered anywhere (HUD, WhatsApp, timeout). */
  async abilitiesStatus(): Promise<AbilitiesStatus | null> {
    try {
      return await this.request<AbilitiesStatus>('abilities.status', {});
    } catch {
      return null;
    }
  }

  async addFolder(folder: string): Promise<AbilitiesStatus['files']> {
    return this.request('abilities.files.add', { folder });
  }

  async removeFolder(folder: string): Promise<AbilitiesStatus['files']> {
    return this.request('abilities.files.remove', { folder });
  }

  private jobListeners = new Set<(job: BackgroundJob) => void>();
  /** A background job changed (step started/finished, waiting for Sir, done). */
  onJob(cb: (job: BackgroundJob) => void): () => void {
    this.jobListeners.add(cb);
    return () => this.jobListeners.delete(cb);
  }

  async listJobs(): Promise<BackgroundJob[]> {
    try {
      const res = await this.request<{ jobs?: BackgroundJob[] }>('jobs.list', {});
      return Array.isArray(res?.jobs) ? res.jobs : [];
    } catch {
      return [];
    }
  }

  private evolutionListeners = new Set<(p: { summary: string; pending: number }) => void>();
  onEvolution(cb: (p: { summary: string; pending: number }) => void): () => void {
    this.evolutionListeners.add(cb);
    return () => this.evolutionListeners.delete(cb);
  }

  onApprovalResolved(cb: (id: string) => void) {
    this.approvalResolvedListeners.push(cb);
    return () => {
      this.approvalResolvedListeners = this.approvalResolvedListeners.filter((l) => l !== cb);
    };
  }

  constructor(
    url = 'ws://127.0.0.1:18789',
    // Electron supplies the real token from ~/.friday/friday.json via setCredentials();
    // the browser dev page can use VITE_FRIDAY_GATEWAY_TOKEN in friday-hud/.env.local.
    token: string = import.meta.env.VITE_FRIDAY_GATEWAY_TOKEN ?? ''
  ) {
    this.url = url;
    this.token = token;
  }

  setCredentials(url: string, token: string) {
    if (url === this.url && token === this.token) return; // nothing changed: keep the live link
    this.url = url;
    this.token = token;
    if (this.ws) {
      this.disconnect();
      this.connect();
    }
  }

  get connected(): boolean {
    return this.isConnected;
  }

  /** The gateway WebSocket URL this client talks to. */
  get endpoint(): string {
    return this.url;
  }

  /** Consecutive failed connection attempts (0 while connected). Lets the UI say "reconnecting". */
  get reconnectAttempts(): number {
    return this.attempts;
  }

  connect() {
    this.wantConnected = true;
    this.ensureLifecycleHooks();
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    const gen = ++this.gen;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.attempts += 1;
      this.setConnectedState(false);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.lastFrameAt = Date.now();

    ws.onopen = () => {
      if (gen !== this.gen) return;
      // The gateway should challenge right away; if it never does, this socket is useless.
      this.handshakeTimer = setTimeout(() => {
        if (gen === this.gen && !this.isConnected) this.dropSocket('handshake timed out');
      }, 10_000);
    };

    ws.onmessage = (event) => {
      if (gen !== this.gen) return;
      this.lastFrameAt = Date.now();
      try {
        this.handleFrame(JSON.parse(event.data));
      } catch (e) {
        console.error('[FRIDAY WS] Frame error:', e);
      }
    };

    ws.onclose = () => {
      if (gen !== this.gen) return; // an older socket we already replaced
      this.dropSocket('closed');
    };

    ws.onerror = (err) => {
      console.warn('[FRIDAY WS] Connection error:', err);
    };
  }

  /** Intentional stop (gateway not running yet, credentials changing). No automatic reconnect. */
  disconnect() {
    this.wantConnected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.teardown('disconnected');
  }

  /** Throw the current socket away and schedule a reconnect (connection lost or gone silent). */
  private dropSocket(reason: string) {
    this.teardown(reason);
    this.attempts += 1;
    if (this.wantConnected) this.scheduleReconnect();
  }

  private teardown(reason: string) {
    this.gen += 1; // invalidates every handler of the old socket
    const ws = this.ws;
    this.ws = null;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.hbTimer = null;
    this.pingInFlight = false;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
    // Nothing waits forever on a connection that no longer exists.
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`FRIDAY Gateway ${reason} (${p.method})`));
      this.pending.delete(id);
    }
    this.setConnectedState(false);
  }

  /** Connect again right now (network back, window woken, user focus), skipping the backoff wait. */
  private reconnectNow() {
    if (!this.wantConnected) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.backoffMs = 1000;
    if (this.ws && this.isConnected) return;
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) return;
    this.connect();
  }

  private lifecycleHooked = false;
  private ensureLifecycleHooks() {
    if (this.lifecycleHooked || typeof window === 'undefined') return;
    this.lifecycleHooked = true;
    const wake = () => {
      if (!this.wantConnected) return;
      if (!this.isConnected) this.reconnectNow();
      else void this.probe(4000); // maybe the machine slept: prove the link is alive
    };
    window.addEventListener('online', wake);
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) wake();
    });
  }

  /** Ask the gateway something tiny. No answer in time means the socket is dead: replace it. */
  private async probe(timeoutMs: number) {
    if (this.pingInFlight || !this.isConnected) return;
    this.pingInFlight = true;
    const gen = this.gen;
    try {
      await this.request('health', {}, undefined, timeoutMs);
    } catch {
      if (gen === this.gen && this.isConnected) this.dropSocket('stopped answering');
    } finally {
      if (gen === this.gen) this.pingInFlight = false;
    }
  }

  private setConnectedState(state: boolean) {
    if (this.isConnected !== state) {
      this.isConnected = state;
      this.statusListeners.forEach((cb) => cb(state));
    }
  }

  private startHeartbeat() {
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.lastTickAt = Date.now();
    this.hbTimer = setInterval(() => {
      const now = Date.now();
      // Timers freeze while the computer sleeps: a big gap means we just woke up.
      const woke = now - this.lastTickAt > 20_000;
      this.lastTickAt = now;
      if (!this.isConnected) return;
      const idle = now - this.lastFrameAt;
      if (woke) void this.probe(4000);
      else if (idle > 45_000) this.dropSocket('went silent');
      else if (idle > 15_000) void this.probe(8000);
      this.watchPendingRun(now);
    }, 5000);
  }

  /**
   * A turn that has produced no events for a while may have lost its final event (dropped link,
   * sleep). Ask the gateway for the truth instead of leaving "thinking..." on screen forever.
   */
  private watchPendingRun(now: number) {
    if (!this.pendingRunId || this.recovering || this.runStartedAt == null) return;
    if (now - this.lastRunEventAt < 90_000) return;
    this.recoverPendingRun(undefined);
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || !this.wantConnected) return;
    const jitter = Math.random() * 400;
    const delay = Math.min(this.backoffMs, 10_000) + jitter;
    this.backoffMs = Math.min(this.backoffMs * 1.7, 10_000);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /** Resolves when the link is up (or rejects after timeoutMs). Used so a send during a blip waits. */
  whenConnected(timeoutMs: number): Promise<void> {
    if (this.isConnected) return Promise.resolve();
    this.reconnectNow();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        off();
        reject(new Error('FRIDAY Gateway not connected'));
      }, timeoutMs);
      const off = this.onStatus((c) => {
        if (!c) return;
        clearTimeout(t);
        off();
        resolve();
      });
    });
  }

  private sendChallengeConnect() {
    const id = 'conn_' + Math.random().toString(36).substring(2, 9);
    const params = {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: 'cli',
        version: '1.0.0',
        platform: 'linux',
        mode: 'cli',
      },
      role: 'operator',
      scopes: ['operator.admin', 'operator.approvals', 'operator.pairing'],
      auth: { token: this.token },
    };

    const gen = this.gen;
    this.request('connect', params, id)
      .then((hello: any) => {
        if (gen !== this.gen) return; // that socket was already replaced
        if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
        this.backoffMs = 1000;
        this.attempts = 0;
        this.lastFrameAt = Date.now();
        this.setConnectedState(true);
        this.startHeartbeat();
        this.recoverPendingRun(hello?.snapshot?.uptimeMs);
      })
      .catch((err) => {
        // A socket that never authenticates is useless and would sit open forever: retry cleanly.
        if (gen !== this.gen) return; // a stale failure must not tear down the new socket
        console.warn('[FRIDAY WS] Auth handshake failed:', err);
        this.dropSocket('handshake failed');
      });
  }

  request<T = any>(method: string, params: any = {}, customId?: string, timeoutMs = 30_000): Promise<T> {
    return new Promise((resolve, reject) => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('FRIDAY Gateway not connected'));
      }
      const id = customId || 'req_' + Math.random().toString(36).substring(2, 9);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`FRIDAY Gateway timed out (${method})`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        ws.send(JSON.stringify({ type: 'req', id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  private handleFrame(frame: any) {
    if (frame.type === 'res') {
      const p = this.pending.get(frame.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(frame.id);
        if (frame.ok) p.resolve(frame.payload);
        else p.reject(frame.error || new Error(frame.error?.message || 'Gateway request failed'));
      }
    } else if (frame.type === 'event') {
      if (frame.event === 'connect.challenge') {
        this.sendChallengeConnect();
      } else if (frame.event === 'agent') {
        this.lastRunEventAt = Date.now();
        const payload = frame.payload;
        if (payload) {
          this.handleAgentEvent(payload);
        }
      } else if (frame.event === 'chat') {
        this.lastRunEventAt = Date.now();
        const payload = frame.payload;
        if (payload) {
          const state = payload.state;
          const msg = payload.message;
          let text = '';
          let thinking = '';
          const toolCalls: any[] = [];

          if (msg && Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if (part.type === 'text') text += part.text || '';
              if (part.type === 'thinking') thinking += part.thinking || '';
              if (part.type === 'toolCall' || part.type === 'toolUse') {
                toolCalls.push(part);
              }
            }
          }
          const isDone = state === 'final' || state === 'error' || state === 'aborted';
          if (isDone) {
            this.currentRunActivities.forEach((a) => {
              if (a.status === 'running') {
                a.status = 'completed';
                if (a.toolCall) a.toolCall.status = 'completed';
              }
            });
          }
          const runId = typeof payload.runId === 'string' ? payload.runId : undefined;
          if (isDone && runId && runId === this.pendingRunId) this.pendingRunId = null;
          this.messageListeners.forEach((cb) => cb(text, thinking, isDone, toolCalls, runId));
        }
      } else if (frame.event === 'exec.approval.requested') {
        const req: ExecApprovalRequest = {
          id: frame.payload?.id || 'appr_' + Date.now(),
          agentId: frame.payload?.agentId,
          command: frame.payload?.command || frame.payload?.commandLine,
          toolName: frame.payload?.toolName || 'bash',
          args: frame.payload?.args,
          requestedAt: Date.now(),
          status: 'pending',
        };
        this.trackPendingApproval(req.id, true);
        this.approvalListeners.forEach((cb) => cb(req));
      } else if (frame.event === 'exec.approval.resolved') {
        // Resolved anywhere (HUD, WhatsApp, timeout): stop showing "awaiting approval".
        if (frame.payload?.id) this.trackPendingApproval(frame.payload.id, false);
      } else if (frame.event === 'job') {
        if (frame.payload?.id) this.jobListeners.forEach((cb) => cb(frame.payload));
      } else if (frame.event === 'evolution') {
        this.evolutionListeners.forEach((cb) => cb(frame.payload));
      } else if (frame.event === 'logs') {
        if (Array.isArray(frame.payload?.lines)) {
          this.logListeners.forEach((cb) => cb(frame.payload.lines));
        }
      }
    }
  }

  private handleAgentEvent(payload: any) {
    const stream = payload.stream;
    const data = payload.data || {};
    const ts = payload.ts || Date.now();

    if (stream === 'tool') {
      const phase = data.phase;
      const toolCallId = data.toolCallId || 'tool_' + ts;
      const toolName = data.name || 'exec';

      let existing = this.currentRunActivities.find(
        (a) => a.type === 'action' && a.toolCall?.id === toolCallId
      );

      if (phase === 'start') {
        if (!existing) {
          const step: ActivityStep = {
            id: toolCallId,
            type: 'action',
            title: `Tool: ${toolName}`,
            status: 'running',
            timestamp: ts,
            toolCall: {
              id: toolCallId,
              name: toolName,
              input: data.args,
              status: 'running',
              startedAt: ts,
            },
          };
          this.currentRunActivities.push(step);
          existing = step;
        } else if (existing.toolCall) {
          existing.toolCall.status = 'running';
          existing.toolCall.input = data.args || existing.toolCall.input;
          existing.status = 'running';
        }
      } else if (phase === 'update') {
        if (existing && existing.toolCall) {
          existing.toolCall.result =
            typeof data.partialResult === 'string'
              ? data.partialResult
              : JSON.stringify(data.partialResult, null, 2);
        }
      } else if (phase === 'result' || phase === 'end') {
        const isError = Boolean(data.isError);
        const resultText =
          typeof data.result === 'string'
            ? data.result
            : data.result
            ? JSON.stringify(data.result, null, 2)
            : undefined;
        if (!existing) {
          const step: ActivityStep = {
            id: toolCallId,
            type: 'action',
            title: `Tool: ${toolName}`,
            status: isError ? 'error' : 'completed',
            timestamp: ts,
            toolCall: {
              id: toolCallId,
              name: toolName,
              input: data.args,
              result: resultText,
              isError,
              status: isError ? 'error' : 'completed',
              startedAt: ts,
              completedAt: ts,
            },
          };
          this.currentRunActivities.push(step);
          existing = step;
        } else if (existing.toolCall) {
          existing.status = isError ? 'error' : 'completed';
          existing.toolCall.status = isError ? 'error' : 'completed';
          existing.toolCall.isError = isError;
          if (resultText !== undefined) existing.toolCall.result = resultText;
          existing.toolCall.completedAt = ts;
          if (existing.toolCall.startedAt) {
            existing.toolCall.durationMs = ts - existing.toolCall.startedAt;
            existing.durationMs = existing.toolCall.durationMs;
          }
        }
      }

      if (existing) {
        this.activityListeners.forEach((cb) => cb(existing!, [...this.currentRunActivities]));
      }
    } else if (stream === 'thinking') {
      const text = cleanReasoning(data.text);
      const steps = this.currentRunActivities;
      const last = steps[steps.length - 1];
      // One thought per model step: a thought after a tool call is a new step, so the timeline
      // reads in order (think, act, think, act, answer) the way it happened.
      if (text && !steps.some((a) => a.type === 'thinking' && a.content === text)) {
        if (last && last.type === 'thinking') {
          last.content = text;
        } else {
          const prevEnd = last?.toolCall?.completedAt ?? last?.timestamp ?? this.runStartedAt ?? ts;
          steps.push({
            id: `think_${steps.length}_${ts}`,
            type: 'thinking',
            title: 'Thinking',
            content: text,
            status: 'completed',
            timestamp: ts,
            durationMs: Math.max(0, ts - prevEnd),
          });
        }
        const step = steps[steps.length - 1];
        this.activityListeners.forEach((cb) => cb(step, [...steps]));
      }
    } else if (stream === 'lifecycle' && (data.phase === 'end' || data.phase === 'error')) {
      let changed: ActivityStep | null = null;
      this.currentRunActivities.forEach((a) => {
        if (a.status === 'running') {
          a.status = 'completed';
          if (a.toolCall) a.toolCall.status = 'completed';
          changed = a;
        }
      });
      // Tell listeners, or the HUD would keep showing tools as running after the run ended.
      if (changed) this.activityListeners.forEach((cb) => cb(changed!, [...this.currentRunActivities]));
    } else if (stream === 'affect') {
      // The runner's computed affect vector for this run.
      presence.setAffect(data);
    } else if (stream === 'reflection') {
      // Real plan/reflect output from the runner: lessons recalled before acting, lesson recorded after.
      if (data.phase === 'recall' && Array.isArray(data.lessons)) {
        for (const lesson of data.lessons) this.emitThought({ kind: 'recall', text: String(lesson), ts });
      } else if (data.phase === 'lesson' && typeof data.lesson === 'string') {
        this.emitThought({ kind: 'lesson', text: data.lesson, outcome: data.outcome, ts });
      }
    }
    if (stream === 'thinking' && typeof data.text === 'string' && data.text) {
      this.emitThought({ kind: 'reasoning', text: cleanReasoning(data.text), ts });
    }
  }

  private runStartedAt: number | null = null;
  private pendingSessionKey = 'agent:main:main';

  /**
   * After a reconnect, Sir's pending turn would otherwise wait forever: the events it was
   * waiting for went to the old connection. If the gateway restarted since the run began, the
   * run is gone, so say so; if it was only a dropped connection, wait for the run and show its reply.
   */
  private recoverPendingRun(uptimeMs: unknown) {
    const runId = this.pendingRunId;
    if (!runId || this.runStartedAt == null || this.recovering) return;
    this.recovering = true;
    const finish = (text: string) => {
      this.recovering = false;
      this.lastRunEventAt = Date.now();
      if (this.pendingRunId !== runId) return; // its events arrived after all
      this.pendingRunId = null;
      this.messageListeners.forEach((cb) => cb(text, '', true, [], runId));
    };
    const gatewayStartedAt = typeof uptimeMs === 'number' ? Date.now() - uptimeMs : null;
    if (gatewayStartedAt != null && gatewayStartedAt > this.runStartedAt) {
      finish("Sorry, Sir, I restarted while I was working on that, so I lost it. Could you send it again?");
      return;
    }
    const sessionKey = this.pendingSessionKey;
    void this.request<{ status?: string }>('agent.wait', { runId, timeoutMs: 600_000 }, undefined, 615_000)
      .then(async (res) => {
        if (res?.status === 'timeout') return finish("That one's taking far too long, Sir. Shall I try again?");
        const history = await this.getChatHistory(6, sessionKey);
        const last = [...history].reverse().find((m) => m.role === 'assistant');
        finish(last?.text ?? '');
      })
      .catch(() => finish(''));
  }

  private thoughtListeners: ((t: Thought) => void)[] = [];

  private emitThought(t: Thought) {
    this.thoughtListeners.forEach((cb) => cb(t));
  }

  /** Reasoning text (cumulative per run), recalled lessons and recorded lessons, as they happen. */
  onThought(cb: (t: Thought) => void) {
    this.thoughtListeners.push(cb);
    return () => {
      this.thoughtListeners = this.thoughtListeners.filter((l) => l !== cb);
    };
  }

  // --- RPC Methods ---

  async getStatus(): Promise<GatewayStatusPayload> {
    return this.request<GatewayStatusPayload>('status', {});
  }

  async getHealth(): Promise<any> {
    return this.request('health', {});
  }

  async getChannels(probe = false): Promise<ChannelsStatus> {
    return this.request<ChannelsStatus>('channels.status', { probe });
  }

  async getSkills(): Promise<{ skills: SkillItem[]; workspaceDir?: string; managedSkillsDir?: string }> {
    const res = await this.request('skills.status', {});
    const rawSkills = Array.isArray(res?.skills) ? res.skills : [];
    const skills: SkillItem[] = rawSkills.map((s: any) => ({
      name: s.name,
      description: s.description || 'FRIDAY cognitive skill',
      source: s.source || (s.managed ? 'managed' : 'workspace'),
      enabled: !s.disabled,
    }));
    return {
      skills,
      workspaceDir: res?.workspaceDir,
      managedSkillsDir: res?.managedSkillsDir,
    };
  }

  async updateSkill(skillKey: string, enabled: boolean): Promise<any> {
    return this.request('skills.update', { skillKey, enabled });
  }

  async getCronJobs(includeDisabled = true): Promise<CronJobItem[]> {
    const res = await this.request('cron.list', { includeDisabled });
    return Array.isArray(res?.jobs) ? res.jobs : [];
  }

  async runCronJob(id: string): Promise<any> {
    return this.request('cron.run', { id, mode: 'force' });
  }

  async updateCronJob(id: string, enabled: boolean): Promise<any> {
    return this.request('cron.update', { id, patch: { enabled } });
  }

  async getApprovals(): Promise<any> {
    return this.request('exec.approvals.get', {});
  }

  async resolveApproval(id: string, decision: 'allow' | 'deny'): Promise<any> {
    this.trackPendingApproval(id, false);
    return this.request('exec.approval.resolve', { id, decision });
  }

  async getLogs(limit = 150): Promise<{ lines: string[]; file?: string }> {
    const res = await this.request('logs.tail', { limit });
    return {
      lines: Array.isArray(res?.lines) ? res.lines : [],
      file: res?.file,
    };
  }

  async listSessions(opts?: {
    limit?: number;
    search?: string;
    includeDerivedTitles?: boolean;
    includeLastMessage?: boolean;
  }): Promise<SessionItem[]> {
    try {
      const res = await this.request('sessions.list', {
        limit: opts?.limit ?? 40,
        search: opts?.search,
        includeDerivedTitles: opts?.includeDerivedTitles ?? true,
        includeLastMessage: opts?.includeLastMessage ?? true,
      });
      return Array.isArray(res?.sessions) ? res.sessions : [];
    } catch (e) {
      console.warn('Failed to list sessions:', e);
      return [];
    }
  }

  async resetSession(key = 'agent:main:main'): Promise<any> {
    return this.request('sessions.reset', { key });
  }

  async deleteSession(key: string): Promise<any> {
    return this.request('sessions.delete', { key });
  }

  async getChatHistory(limit = 50, sessionKey = 'agent:main:main'): Promise<ChatMessage[]> {
    try {
      const res = await this.request('chat.history', { sessionKey, limit });
      const rawMessages = Array.isArray(res?.messages) ? res.messages : [];
      const messages: ChatMessage[] = [];

      // Pass 1: Map all tool results by their toolCallId
      const toolResults = new Map<string, { text: string; isError?: boolean }>();
      for (const m of rawMessages) {
        if (m.role === 'toolResult') {
          const callId = m.toolCallId || m.id;
          let resultText = '';
          if (typeof m.content === 'string') {
            resultText = m.content;
          } else if (Array.isArray(m.content)) {
            for (const part of m.content) {
              if (part.type === 'text') resultText += part.text || '';
              else if (typeof part === 'string') resultText += part;
              else resultText += JSON.stringify(part, null, 2);
            }
          }
          if (callId) {
            toolResults.set(callId, {
              text: resultText.trim(),
              isError: Boolean(m.isError),
            });
          }
        }
      }

      // Pass 2: one chat message per turn. A turn with tools is several model steps; they are
      // merged into one ordered timeline (thought, note, tool, thought, ..., answer).
      const stamp = (m: any, i: number) => m.timestamp || Date.now() - (rawMessages.length - i) * 60000;
      for (let i = 0; i < rawMessages.length; i++) {
        const m = rawMessages[i];
        if (m.role === 'toolResult') continue;

        let text = '';
        let thinking = '';
        const toolCalls: ToolCallStep[] = [];
        const activities: ActivityStep[] = [];
        const ts = stamp(m, i);

        if (typeof m.content === 'string') {
          text = m.content;
        } else if (Array.isArray(m.content)) {
          for (const c of m.content) {
            if (c.type === 'text') {
              text += (text ? '\n\n' : '') + (c.text || '');
            } else if (c.type === 'thinking') {
              const thinkText = cleanReasoning(c.thinking || '');
              if (!thinkText) continue;
              thinking += (thinking ? '\n\n' : '') + thinkText;
              activities.push({
                id: `think_${i}_${activities.length}`,
                type: 'thinking',
                title: 'Thinking',
                content: thinkText,
                status: 'completed',
                timestamp: ts,
              });
            } else if (c.type === 'toolCall' || c.type === 'toolUse') {
              const callId = c.id || c.toolCallId || `call_${i}_${toolCalls.length}`;
              const resInfo = toolResults.get(callId);
              const toolStep: ToolCallStep = {
                id: callId,
                name: c.name || 'tool',
                input: c.input || c.arguments || {},
                result: resInfo?.text,
                isError: resInfo?.isError,
                status: resInfo ? (resInfo.isError ? 'error' : 'completed') : 'completed',
              };
              toolCalls.push(toolStep);
              activities.push({
                id: callId,
                type: 'action',
                title: toolStep.name,
                status: toolStep.status,
                toolCall: toolStep,
                timestamp: ts,
              });
            }
          }
        }
        text = stripReplyTags(text);

        const prev = messages[messages.length - 1];
        const continuesTurn = m.role === 'assistant' && prev?.role === 'assistant' && prev.id.startsWith('turn_');
        if (continuesTurn) {
          // The earlier step's words were a note on the way, not the answer.
          const steps = prev.activities ?? [];
          if (prev.text) steps.push({ id: `note_${i}`, type: 'text', title: 'Note', content: prev.text, status: 'completed', timestamp: prev.timestamp });
          prev.activities = [...steps, ...activities];
          prev.toolCalls = [...(prev.toolCalls ?? []), ...toolCalls];
          prev.thinking = [prev.thinking, thinking].filter(Boolean).join('\n\n') || undefined;
          prev.text = text;
          continue;
        }
        if (text || thinking || toolCalls.length > 0) {
          messages.push({
            id: m.role === 'assistant' ? `turn_${m.id || i}` : m.id || `hist_${i}_${Date.now()}`,
            role: m.role === 'user' ? 'user' : 'assistant',
            text,
            thinking: thinking || undefined,
            toolCalls: toolCalls.length ? toolCalls : undefined,
            activities: activities.length ? activities : undefined,
            timestamp: ts,
          });
        }
      }
      return collapseHeartbeats(messages);
    } catch (e) {
      console.warn('Failed to load chat history:', e);
      return [];
    }
  }

  async sendMessage(
    message: string,
    sessionKey = 'agent:main:main',
    attachments?: Array<{ type: string; mimeType: string; fileName: string; content: string }>,
  ): Promise<void> {
    this.currentRunActivities = [];
    this.runStartedAt = Date.now();
    this.pendingSessionKey = sessionKey;
    const runId = 'run_' + Date.now();
    this.pendingRunId = runId;
    this.lastRunEventAt = Date.now();
    const params = {
      sessionKey,
      message,
      deliver: false,
      idempotencyKey: runId,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    };
    try {
      await this.whenConnected(8000); // a blip or a wake-up from sleep: wait for the link, don't fail
      await this.request('chat.send', params, undefined, 45_000);
    } catch (first) {
      // One retry on a fresh link. The same idempotency key means it can never run twice.
      try {
        await this.whenConnected(10_000);
        await this.request('chat.send', params, undefined, 45_000);
      } catch (e) {
        this.pendingRunId = null;
        throw e instanceof Error ? e : first;
      }
    }
  }

  async abortChat(sessionKey = 'agent:main:main'): Promise<void> {
    await this.request('chat.abort', { sessionKey });
  }

  // --- Listeners ---

  onMessage(cb: (text: string, thinking?: string, isDone?: boolean, toolCalls?: any[], runId?: string) => void) {
    this.messageListeners.push(cb);
    return () => {
      this.messageListeners = this.messageListeners.filter((l) => l !== cb);
    };
  }

  onStatus(cb: (connected: boolean) => void) {
    this.statusListeners.push(cb);
    cb(this.isConnected);
    return () => {
      this.statusListeners = this.statusListeners.filter((l) => l !== cb);
    };
  }

  onApprovalRequested(cb: (approval: ExecApprovalRequest) => void) {
    this.approvalListeners.push(cb);
    return () => {
      this.approvalListeners = this.approvalListeners.filter((l) => l !== cb);
    };
  }

  onLogs(cb: (lines: string[]) => void) {
    this.logListeners.push(cb);
    return () => {
      this.logListeners = this.logListeners.filter((l) => l !== cb);
    };
  }

  onActivity(cb: (activity: ActivityStep, allActivities: ActivityStep[]) => void) {
    this.activityListeners.push(cb);
    return () => {
      this.activityListeners = this.activityListeners.filter((l) => l !== cb);
    };
  }

  getCurrentActivities(): ActivityStep[] {
    return [...this.currentRunActivities];
  }

  /** Snapshot of the current run's activities (tool calls, thinking). */
  currentActivities(): ActivityStep[] {
    return [...this.currentRunActivities];
  }

  clearCurrentActivities(): void {
    this.currentRunActivities = [];
  }
}

export const gateway = new FridayGatewayClient();

// Dev-only handle for simulating gateway events while building HUD panels.
if (import.meta.env.DEV) (window as unknown as { __gateway: FridayGatewayClient }).__gateway = gateway;

const HEARTBEAT_PROMPT = /^Read HEARTBEAT\.md if it exists/;

/**
 * FRIDAY's autonomy checks arrive as a user-role prompt plus a reply. Show them as one small
 * system divider instead of as if Sir had typed the prompt; quiet checks (HEARTBEAT_OK) fold in.
 */
/** The runner wraps streamed reasoning as "Reasoning:\n_line_" for chat apps; the HUD wants plain text. */
/** Delivery tags like [[reply_to_current]] are for chat apps, never shown. */
export function stripReplyTags(text: string): string {
  // A reply still streaming may begin with a tag that isn't finished yet.
  if (/^\s*\[\[[^\]]*$/.test(text)) return '';
  return text.replace(/\[\[\s*(?:reply_to_current|reply_to\s*:[^\]\n]+|audio_as_voice)\s*\]\]\s*/gi, '').trim();
}

export function cleanReasoning(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/^\s*Reasoning:\s*\n?/, '')
    .split('\n')
    .map((line) => line.replace(/^_(.*)_$/, '$1'))
    .join('\n')
    .trim();
}

export function collapseHeartbeats(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'user' && HEARTBEAT_PROMPT.test(m.text.trim())) {
      const next = messages[i + 1];
      const quiet = next?.role === 'assistant' && /^\s*HEARTBEAT_OK\s*$/.test(next.text);
      out.push({ id: m.id, role: 'system', text: quiet ? 'Autonomy check · nothing needed attention' : 'Autonomy check', timestamp: m.timestamp });
      if (quiet) i++;
      continue;
    }
    out.push(m);
  }
  return out;
}
