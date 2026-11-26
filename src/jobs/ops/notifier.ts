/**
 * Notifier (Requirements 8.4, 8.5, 8.9). Sends approval requests and reminders through the HUD and
 * WhatsApp. Each channel is an injectable `ChannelSender`, so delivery, retry and reminder logic is
 * testable with fake senders and a fake clock. Digest (13.2) and Quiet_Hours (13.3, 13.4) reuse the
 * same `NotificationMessage` and `deliverToChannel` primitives.
 *
 * The Notifier never changes Task or Job state. A Task in waiting_approval stays actionable through a
 * channel that did deliver; the per-channel outcome is returned and reported through `onEvent` so the
 * Orchestrator can record it in the Event_Log.
 */

import {
  type DigestConfig,
  type DigestEntry,
  formatDigestText,
  msUntilDigestDue,
  resolveDigestSchedule,
  type ResolvedDigestSchedule,
} from "./digest.js";
import {
  boundedDelay,
  isQuietAt,
  localClock,
  msUntilQuietEnd,
  type QuietHoursConfig,
  resolveQuietHours,
  type ResolvedQuietHours,
} from "./quiet-hours.js";

export type { DigestConfig, DigestEntry } from "./digest.js";
export type { QuietHoursApprovalSetting, QuietHoursConfig } from "./quiet-hours.js";

/** What a Task is waiting on. `action` is the human-readable action (e.g. "git push origin main"). */
export type ApprovalRequest = {
  jobId: string;
  taskId: string;
  action: string;
  /** Why the action needs approval (from `neverAutoReason`), when known. */
  reason?: string;
};

/**
 * Notification kinds. "approval-request" and "approval-reminder" carry the Job, Task and action.
 * "digest" carries `entries`. "notice" is any other plain notification (e.g. a Health_Monitor alert).
 * Quiet_Hours hold every kind except approvals.
 */
export type NotificationMessage = {
  kind: "approval-request" | "approval-reminder" | "digest" | "notice";
  jobId?: string;
  taskId?: string;
  action?: string;
  reason?: string;
  /** Digest only: the Jobs whose status changed since the previous Digest. */
  entries?: DigestEntry[];
  /** 1-based reminder count; absent on the first request. */
  reminderNumber?: number;
  /** Plain-text rendering, ready for WhatsApp or a HUD toast. */
  text: string;
  createdAtMs: number;
};

/** One delivery channel. `send` rejects when the message was not delivered. */
export interface ChannelSender {
  readonly channel: string;
  send(message: NotificationMessage): Promise<void>;
}

/** Timer and clock seam. Defaults to the global timers, looked up at call time (fake-timer safe). */
export type NotifierClock = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export const systemClock: NotifierClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Retries after the first failed attempt, and the gap between attempts (Requirement 8.5). */
export const DELIVERY_RETRY_LIMIT = 3;
export const DELIVERY_RETRY_DELAY_MS = 10_000;

/** Reminder interval bounds and default (Requirement 8.9). */
export const MIN_REMINDER_INTERVAL_MS = 60_000;
export const MAX_REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_REMINDER_INTERVAL_MS = 15 * 60 * 1000;

/** A single send attempt that has not settled by then counts as failed, so retries can proceed. */
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 30_000;

/**
 * Accept an integer number of milliseconds from 1 minute to 24 hours. Anything else yields the
 * 15-minute default with `usedDefault: true` so the caller can record the rejected value.
 */
export function validateReminderIntervalMs(input: unknown): {
  value: number;
  usedDefault: boolean;
} {
  if (
    typeof input === "number" &&
    Number.isInteger(input) &&
    input >= MIN_REMINDER_INTERVAL_MS &&
    input <= MAX_REMINDER_INTERVAL_MS
  ) {
    return { value: input, usedDefault: false };
  }
  return { value: DEFAULT_REMINDER_INTERVAL_MS, usedDefault: true };
}

/** Message body naming the Job, the Task and the action awaiting approval (Requirement 8.4). */
export function formatApprovalText(
  req: ApprovalRequest,
  opts: { reminderNumber?: number } = {},
): string {
  const head = opts.reminderNumber
    ? `Reminder ${opts.reminderNumber}: approval still needed`
    : "Approval needed";
  const lines = [head, `Job: ${req.jobId}`, `Task: ${req.taskId}`, `Action: ${req.action}`];
  if (req.reason) lines.push(`Reason: ${req.reason}`);
  return lines.join("\n");
}

export type ChannelResult = {
  channel: string;
  delivered: boolean;
  /** Total send attempts made (first attempt plus retries). */
  attempts: number;
  /** Last error message when not delivered. */
  error?: string;
  /** True when delivery stopped early because the decision was applied. */
  cancelled?: boolean;
};

export type ApprovalDeliveryReport = {
  jobId: string;
  taskId: string;
  results: ChannelResult[];
  /** True when at least one channel delivered, so the Task is actionable somewhere. */
  anyDelivered: boolean;
};

export type NotifierEvent =
  | { type: "delivered"; channel: string; message: NotificationMessage; attempts: number }
  | {
      type: "retry-scheduled";
      channel: string;
      message: NotificationMessage;
      attempt: number;
      error: string;
    }
  | {
      type: "channel-failed";
      channel: string;
      message: NotificationMessage;
      attempts: number;
      error: string;
    }
  | { type: "reminder-sent"; jobId: string; taskId: string; reminderNumber: number }
  | { type: "reminders-stopped"; jobId: string; taskId: string }
  | { type: "digest-generated"; entries: number }
  | { type: "held"; kind: NotificationMessage["kind"]; queued: number }
  | { type: "released"; count: number };

type Waiter = { handle: unknown; wake: () => void };

/** Shared by approval and (later) digest delivery. Retries one channel up to 3 times, 10s apart. */
async function deliverToChannel(args: {
  sender: ChannelSender;
  message: NotificationMessage;
  clock: NotifierClock;
  attemptTimeoutMs: number;
  isCancelled: () => boolean;
  /** Waits `ms`, resolving early when delivery is cancelled. */
  sleep: (ms: number) => Promise<void>;
  emit: (e: NotifierEvent) => void;
}): Promise<ChannelResult> {
  const { sender, message, clock, attemptTimeoutMs, isCancelled, sleep, emit } = args;
  let attempts = 0;
  let lastError = "unknown error";
  for (let retry = 0; retry <= DELIVERY_RETRY_LIMIT; retry++) {
    if (retry > 0) {
      await sleep(DELIVERY_RETRY_DELAY_MS);
    }
    if (isCancelled()) {
      return {
        channel: sender.channel,
        delivered: false,
        attempts,
        error: lastError,
        cancelled: true,
      };
    }
    attempts++;
    try {
      await sendWithTimeout(sender, message, clock, attemptTimeoutMs);
      emit({ type: "delivered", channel: sender.channel, message, attempts });
      return { channel: sender.channel, delivered: true, attempts };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (retry < DELIVERY_RETRY_LIMIT) {
        emit({
          type: "retry-scheduled",
          channel: sender.channel,
          message,
          attempt: attempts,
          error: lastError,
        });
      }
    }
  }
  emit({ type: "channel-failed", channel: sender.channel, message, attempts, error: lastError });
  return { channel: sender.channel, delivered: false, attempts, error: lastError };
}

function sendWithTimeout(
  sender: ChannelSender,
  message: NotificationMessage,
  clock: NotifierClock,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const handle = clock.setTimeout(
      () => reject(new Error(`${sender.channel} send timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    // A synchronous throw from `send` is a delivery failure too.
    Promise.resolve()
      .then(() => sender.send(message))
      .then(
        () => {
          clock.clearTimeout(handle);
          resolve();
        },
        (err: unknown) => {
          clock.clearTimeout(handle);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
  });
}

type PendingApproval = {
  request: ApprovalRequest;
  cancelled: boolean;
  reminderCount: number;
  reminderHandle: unknown;
  waiters: Set<Waiter>;
  report: Promise<ApprovalDeliveryReport>;
  /** True while the request waits for Quiet_Hours to end. */
  held: boolean;
  /** Set while held. Delivers the request (or reports it cancelled) and settles `report`. */
  release?: () => void;
};

/** A notification delayed by Quiet_Hours, kept in generation order. */
type HeldItem =
  | { type: "plain"; message: NotificationMessage }
  | { type: "approval"; entry: PendingApproval };

export type NotifierOptions = {
  /** Channels to deliver through, normally the HUD and WhatsApp. */
  channels: readonly ChannelSender[];
  clock?: NotifierClock;
  /** Reminder interval in ms. Validated with `validateReminderIntervalMs`. */
  reminderIntervalMs?: number;
  attemptTimeoutMs?: number;
  /** Observer for delivery outcomes, e.g. to append Event_Log rows. Must not throw. */
  onEvent?: (event: NotifierEvent) => void;
  /** Quiet_Hours window and approval setting (Requirements 13.3, 13.4). Omit for no quiet hours. */
  quietHours?: QuietHoursConfig;
  /** Daily Digest time (Requirement 13.2). Omit for no Digest. Scheduling begins at `start()`. */
  digest?: DigestConfig;
  /** `agents.defaults.userTimezone`, used when a time zone is "user" or unset. */
  userTimezone?: string;
};

export class Notifier {
  private readonly channels: readonly ChannelSender[];
  private readonly clock: NotifierClock;
  private readonly attemptTimeoutMs: number;
  private readonly onEvent?: (event: NotifierEvent) => void;
  private readonly pending = new Map<string, PendingApproval>();
  private readonly quiet?: ResolvedQuietHours;
  private readonly digestSchedule?: ResolvedDigestSchedule;
  private held: HeldItem[] = [];
  private flushHandle: unknown;
  private digestHandle: unknown;
  private lastDigestDateKey: string | undefined;
  private started = false;
  private disposed = false;
  private readonly digestChanges = new Map<string, DigestEntry>();
  /** Per-channel tail of non-approval deliveries, so each channel receives them in order. */
  private readonly lanes = new Map<string, { tail: Promise<unknown>; active: number }>();
  private readonly bgWaiters = new Set<Waiter>();
  readonly reminderIntervalMs: number;
  /** True when the supplied interval was out of range and the default was used instead. */
  readonly reminderIntervalRejected: boolean;
  /** Why the Quiet_Hours or Digest config was rejected (feature stays off), if it was. */
  readonly quietHoursError?: string;
  readonly digestError?: string;

  constructor(options: NotifierOptions) {
    this.channels = options.channels;
    this.clock = options.clock ?? systemClock;
    this.attemptTimeoutMs = options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
    this.onEvent = options.onEvent;
    const interval =
      options.reminderIntervalMs === undefined
        ? { value: DEFAULT_REMINDER_INTERVAL_MS, usedDefault: false }
        : validateReminderIntervalMs(options.reminderIntervalMs);
    this.reminderIntervalMs = interval.value;
    this.reminderIntervalRejected = interval.usedDefault;
    if (options.quietHours) {
      const q = resolveQuietHours(options.quietHours, options.userTimezone);
      if (q.ok) this.quiet = q.value;
      else this.quietHoursError = q.error;
    }
    if (options.digest) {
      const d = resolveDigestSchedule(options.digest, options.userTimezone);
      if (d.ok) this.digestSchedule = d.value;
      else this.digestError = d.error;
    }
  }

  /** Begin the daily Digest schedule. Does nothing without a valid `digest` option. */
  start(): void {
    const schedule = this.digestSchedule;
    if (!schedule || this.started || this.disposed) return;
    this.started = true;
    // Started after today's time: the next Digest is tomorrow's, not an immediate one.
    const { dateKey, secondsOfDay } = localClock(this.clock.now(), schedule.timeZone);
    if (secondsOfDay >= schedule.dueSec) this.lastDigestDateKey = dateKey;
    this.scheduleDigest();
  }

  /**
   * Record that a Job's status changed. The next Digest lists the latest status of each such Job, in
   * the order of its most recent change.
   */
  recordJobChange(change: { jobId: string; status: string; completedAtMs?: number }): void {
    this.digestChanges.delete(change.jobId);
    this.digestChanges.set(change.jobId, { ...change, changedAtMs: this.clock.now() });
  }

  /**
   * Send a plain (non-approval) notification to every channel. During Quiet_Hours it is held and
   * delivered, in order, within 60 seconds after they end.
   */
  notify(text: string): { held: boolean } {
    return this.dispatchPlain({ kind: "notice", text, createdAtMs: this.clock.now() });
  }

  /** True while Quiet_Hours are active. */
  isQuietNow(): boolean {
    return this.quiet !== undefined && isQuietAt(this.clock.now(), this.quiet);
  }

  /** Notifications still waiting for Quiet_Hours to end. */
  heldCount(): number {
    return this.held.length;
  }

  /**
   * Send the approval request on every channel at once, starting immediately (well inside the 5s
   * limit), and schedule reminders. Each channel retries independently; one failing channel does not
   * delay or cancel the other. A second call for the same Job and Task returns the first report.
   */
  requestApproval(request: ApprovalRequest): Promise<ApprovalDeliveryReport> {
    const key = pendingKey(request.jobId, request.taskId);
    const existing = this.pending.get(key);
    if (existing) return existing.report;

    const entry: PendingApproval = {
      request,
      cancelled: false,
      reminderCount: 0,
      reminderHandle: undefined,
      waiters: new Set(),
      report: undefined as unknown as Promise<ApprovalDeliveryReport>,
      held: false,
    };
    this.pending.set(key, entry);
    const message = this.buildMessage(request, "approval-request");
    const toReport = (results: ChannelResult[]): ApprovalDeliveryReport => ({
      jobId: request.jobId,
      taskId: request.taskId,
      results,
      anyDelivered: results.some((r) => r.delivered),
    });

    if (this.shouldHoldApprovals()) {
      // Requirement 13.4, setting "hold": delay until Quiet_Hours end. Reminders start on release.
      entry.held = true;
      entry.report = new Promise<ApprovalDeliveryReport>((resolve) => {
        entry.release = () => {
          entry.held = false;
          entry.release = undefined;
          if (entry.cancelled) {
            resolve(
              toReport(
                this.channels.map((c) => ({
                  channel: c.channel,
                  delivered: false,
                  attempts: 0,
                  cancelled: true,
                })),
              ),
            );
            return;
          }
          resolve(this.deliverAll(entry, message).then(toReport));
          this.scheduleReminder(key, entry);
        };
      });
      this.holdItem({ type: "approval", entry }, message.kind);
      return entry.report;
    }

    entry.report = this.deliverAll(entry, message).then(toReport);
    this.scheduleReminder(key, entry);
    return entry.report;
  }

  /**
   * Call as soon as the first decision is applied (or the Job is cancelled). Cancels the reminder
   * timer and any retry still waiting, synchronously, so nothing is sent after this returns.
   * Returns false when no approval was pending for the Task.
   */
  decisionApplied(jobId: string, taskId: string): boolean {
    const key = pendingKey(jobId, taskId);
    const entry = this.pending.get(key);
    if (!entry) return false;
    this.pending.delete(key);
    entry.cancelled = true;
    if (entry.reminderHandle !== undefined) this.clock.clearTimeout(entry.reminderHandle);
    entry.reminderHandle = undefined;
    for (const w of entry.waiters) {
      this.clock.clearTimeout(w.handle);
      w.wake();
    }
    if (entry.held) {
      this.held = this.held.filter((h) => !(h.type === "approval" && h.entry === entry));
      entry.release?.();
    }
    this.emit({ type: "reminders-stopped", jobId, taskId });
    return true;
  }

  isPending(jobId: string, taskId: string): boolean {
    return this.pending.has(pendingKey(jobId, taskId));
  }

  /** Stop everything, for shutdown. */
  dispose(): void {
    this.disposed = true;
    for (const entry of this.pending.values()) {
      this.decisionApplied(entry.request.jobId, entry.request.taskId);
    }
    if (this.flushHandle !== undefined) this.clock.clearTimeout(this.flushHandle);
    if (this.digestHandle !== undefined) this.clock.clearTimeout(this.digestHandle);
    this.flushHandle = undefined;
    this.digestHandle = undefined;
    this.held = [];
    for (const w of this.bgWaiters) {
      this.clock.clearTimeout(w.handle);
      w.wake();
    }
    this.bgWaiters.clear();
  }

  /* ---------------------------- Quiet_Hours and Digest ---------------------------- */

  private shouldHoldApprovals(): boolean {
    return this.quiet?.approvals === "hold" && this.isQuietNow();
  }

  private holdItem(item: HeldItem, kind: NotificationMessage["kind"]): void {
    this.held.push(item);
    this.emit({ type: "held", kind, queued: this.held.length });
    this.scheduleFlush();
  }

  private dispatchPlain(message: NotificationMessage): { held: boolean } {
    if (this.disposed) return { held: false };
    if (this.isQuietNow()) {
      this.holdItem({ type: "plain", message }, message.kind);
      return { held: true };
    }
    // Quiet_Hours just ended but the flush timer has not fired: flush first to keep order.
    if (this.held.length > 0) this.flushHeld();
    void this.sendOrdered(message);
    return { held: false };
  }

  /** Wake when Quiet_Hours end (re-checking the wall clock on each wake) and flush held items. */
  private scheduleFlush(): void {
    if (this.flushHandle !== undefined || this.disposed || !this.quiet) return;
    const until = msUntilQuietEnd(this.clock.now(), this.quiet);
    this.flushHandle = this.clock.setTimeout(() => {
      this.flushHandle = undefined;
      if (this.disposed || this.held.length === 0) return;
      if (this.isQuietNow()) this.scheduleFlush();
      else this.flushHeld();
    }, boundedDelay(until));
  }

  /** Deliver held items in the order they were generated. */
  private flushHeld(): void {
    const items = this.held;
    this.held = [];
    if (items.length === 0) return;
    this.emit({ type: "released", count: items.length });
    for (const item of items) {
      if (item.type === "approval") item.entry.release?.();
      else void this.sendOrdered(item.message);
    }
  }

  /**
   * Deliver a non-approval message on every channel. Messages queue per channel, so a channel
   * receives them in generation order even when an earlier one needs retries.
   */
  private sendOrdered(message: NotificationMessage): Promise<ChannelResult[]> {
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        if (this.disposed) return resolve();
        const waiter: Waiter = { handle: undefined, wake: resolve };
        waiter.handle = this.clock.setTimeout(() => {
          this.bgWaiters.delete(waiter);
          resolve();
        }, ms);
        this.bgWaiters.add(waiter);
      });
    return Promise.all(
      this.channels.map((sender) => {
        const lane = this.lanes.get(sender.channel) ?? { tail: Promise.resolve(), active: 0 };
        const run = () =>
          deliverToChannel({
            sender,
            message,
            clock: this.clock,
            attemptTimeoutMs: this.attemptTimeoutMs,
            isCancelled: () => this.disposed,
            sleep,
            emit: (e) => this.emit(e),
          });
        // An idle lane starts the send at once; a busy lane waits for the earlier messages.
        const next = lane.active === 0 ? run() : lane.tail.then(run);
        lane.active++;
        lane.tail = next;
        this.lanes.set(sender.channel, lane);
        const done = () => {
          lane.active--;
        };
        void next.then(done, done);
        return next;
      }),
    );
  }

  private scheduleDigest(): void {
    const schedule = this.digestSchedule;
    if (!schedule || this.disposed) return;
    const until = msUntilDigestDue(this.clock.now(), schedule, this.lastDigestDateKey);
    this.digestHandle = this.clock.setTimeout(() => {
      this.digestHandle = undefined;
      if (this.disposed) return;
      if (msUntilDigestDue(this.clock.now(), schedule, this.lastDigestDateKey) === 0) {
        this.generateDigest(schedule);
      }
      this.scheduleDigest();
    }, boundedDelay(until));
  }

  /** Build the one Digest for today and dispatch it (held when Quiet_Hours are active). */
  private generateDigest(schedule: ResolvedDigestSchedule): void {
    const now = this.clock.now();
    this.lastDigestDateKey = localClock(now, schedule.timeZone).dateKey;
    const entries = [...this.digestChanges.values()];
    this.digestChanges.clear();
    this.emit({ type: "digest-generated", entries: entries.length });
    this.dispatchPlain({
      kind: "digest",
      entries,
      text: formatDigestText(entries),
      createdAtMs: now,
    });
  }

  private buildMessage(
    request: ApprovalRequest,
    kind: NotificationMessage["kind"],
    reminderNumber?: number,
  ): NotificationMessage {
    return {
      kind,
      jobId: request.jobId,
      taskId: request.taskId,
      action: request.action,
      ...(request.reason ? { reason: request.reason } : {}),
      ...(reminderNumber ? { reminderNumber } : {}),
      text: formatApprovalText(request, { reminderNumber }),
      createdAtMs: this.clock.now(),
    };
  }

  private deliverAll(
    entry: PendingApproval,
    message: NotificationMessage,
  ): Promise<ChannelResult[]> {
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        if (entry.cancelled) return resolve();
        const waiter: Waiter = { handle: undefined, wake: resolve };
        waiter.handle = this.clock.setTimeout(() => {
          entry.waiters.delete(waiter);
          resolve();
        }, ms);
        entry.waiters.add(waiter);
      });
    // allSettled-style: deliverToChannel catches send errors, so this never rejects.
    return Promise.all(
      this.channels.map((sender) =>
        deliverToChannel({
          sender,
          message,
          clock: this.clock,
          attemptTimeoutMs: this.attemptTimeoutMs,
          isCancelled: () => entry.cancelled,
          sleep,
          emit: (e) => this.emit(e),
        }),
      ),
    );
  }

  private scheduleReminder(key: string, entry: PendingApproval): void {
    entry.reminderHandle = this.clock.setTimeout(() => {
      if (entry.cancelled || this.pending.get(key) !== entry) return;
      // Setting "hold": reminders are not sent during Quiet_Hours. The cadence keeps running.
      if (entry.held || this.shouldHoldApprovals()) {
        this.scheduleReminder(key, entry);
        return;
      }
      entry.reminderCount++;
      const message = this.buildMessage(entry.request, "approval-reminder", entry.reminderCount);
      this.emit({
        type: "reminder-sent",
        jobId: entry.request.jobId,
        taskId: entry.request.taskId,
        reminderNumber: entry.reminderCount,
      });
      // Reminders are fire-and-forget; the next one is scheduled on the fixed interval.
      void this.deliverAll(entry, message);
      this.scheduleReminder(key, entry);
    }, this.reminderIntervalMs);
  }

  private emit(event: NotifierEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // An observer failure must never break delivery.
    }
  }
}

function pendingKey(jobId: string, taskId: string): string {
  return JSON.stringify([jobId, taskId]);
}

/* ------------------------------------------------------------------------------------------ */
/* Real channel adapters                                                                       */
/* ------------------------------------------------------------------------------------------ */

/** Matches `GatewayRequestContext.broadcast` in src/gateway/server-methods/types.ts. */
export type GatewayBroadcast = (
  event: string,
  payload: unknown,
  opts?: { dropIfSlow?: boolean },
) => void;

/** Gateway event the HUD listens on for approval requests and reminders. */
export const HUD_APPROVAL_EVENT = "jobs.approval";
/** Gateway event for Digests and other plain notifications. */
export const HUD_NOTICE_EVENT = "jobs.notice";

/**
 * HUD channel: pushes the message to every connected gateway client through the gateway
 * broadcaster. The broadcaster is fire-and-forget and reports no per-client result, so this
 * adapter fails only when the broadcaster itself throws. With no client connected the push is
 * dropped; the WhatsApp channel and the pending Task in the Jobs API remain the fallback.
 */
export function createHudChannel(broadcast: GatewayBroadcast): ChannelSender {
  return {
    channel: "hud",
    async send(message) {
      if (message.kind === "digest" || message.kind === "notice") {
        broadcast(
          HUD_NOTICE_EVENT,
          {
            kind: message.kind,
            entries: message.entries,
            text: message.text,
            createdAtMs: message.createdAtMs,
          },
          { dropIfSlow: false },
        );
        return;
      }
      broadcast(
        HUD_APPROVAL_EVENT,
        {
          kind: message.kind,
          jobId: message.jobId,
          taskId: message.taskId,
          action: message.action,
          reason: message.reason,
          reminderNumber: message.reminderNumber,
          text: message.text,
          createdAtMs: message.createdAtMs,
        },
        { dropIfSlow: false },
      );
    },
  };
}

export type WhatsAppSend = (
  to: string,
  body: string,
  options: { verbose: boolean; accountId?: string },
) => Promise<unknown>;

/**
 * WhatsApp channel over the existing web-session sender (`sendMessageWhatsApp`). The recipient is
 * injected (the owner's number, from config) and is never hard-coded here. A missing recipient or
 * an inactive WhatsApp listener rejects, which the Notifier counts as a delivery failure.
 */
export function createWhatsAppChannel(opts: {
  /** Recipient, or a resolver that reads it from config on each send. */
  to: string | (() => string | undefined);
  accountId?: string;
  /** Override for tests. Defaults to `sendMessageWhatsApp`, imported lazily. */
  send?: WhatsAppSend;
}): ChannelSender {
  return {
    channel: "whatsapp",
    async send(message) {
      const to = typeof opts.to === "function" ? opts.to() : opts.to;
      if (!to) throw new Error("whatsapp recipient is not configured");
      const send = opts.send ?? (await import("../../web/outbound.js")).sendMessageWhatsApp;
      await send(to, message.text, {
        verbose: false,
        ...(opts.accountId ? { accountId: opts.accountId } : {}),
      });
    },
  };
}
