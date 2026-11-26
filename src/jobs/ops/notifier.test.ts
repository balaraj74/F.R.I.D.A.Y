import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ChannelSender,
  createHudChannel,
  createWhatsAppChannel,
  DEFAULT_REMINDER_INTERVAL_MS,
  formatApprovalText,
  HUD_APPROVAL_EVENT,
  type NotificationMessage,
  Notifier,
  type NotifierEvent,
  validateReminderIntervalMs,
} from "./notifier.js";

const req = {
  jobId: "job-1",
  taskId: "task-7",
  action: "git push origin main",
  reason: "pushes code to a remote",
};

/** Sender that records messages and fails its first `failFirst` calls. */
function fakeSender(channel: string, failFirst = 0) {
  const sent: NotificationMessage[] = [];
  let calls = 0;
  const sender: ChannelSender = {
    channel,
    async send(message) {
      calls++;
      if (calls <= failFirst) throw new Error(`${channel} down`);
      sent.push(message);
    },
  };
  return { sender, sent, calls: () => calls };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("validateReminderIntervalMs", () => {
  it("accepts 1 minute to 24 hours inclusive", () => {
    expect(validateReminderIntervalMs(60_000)).toEqual({ value: 60_000, usedDefault: false });
    expect(validateReminderIntervalMs(86_400_000)).toEqual({
      value: 86_400_000,
      usedDefault: false,
    });
  });
  it("falls back to 15 minutes outside the range or for non-integers", () => {
    for (const bad of [59_999, 86_400_001, 1.5, Number.NaN, "900000", undefined, -1]) {
      expect(validateReminderIntervalMs(bad)).toEqual({
        value: DEFAULT_REMINDER_INTERVAL_MS,
        usedDefault: true,
      });
    }
    expect(DEFAULT_REMINDER_INTERVAL_MS).toBe(900_000);
  });
});

describe("approval request delivery (8.4)", () => {
  it("sends to both channels immediately, naming Job, Task and action", async () => {
    const hud = fakeSender("hud");
    const wa = fakeSender("whatsapp");
    const n = new Notifier({ channels: [hud.sender, wa.sender] });
    const report = await n.requestApproval(req);
    expect(report.anyDelivered).toBe(true);
    for (const c of [hud, wa]) {
      expect(c.sent).toHaveLength(1);
      expect(c.sent[0].kind).toBe("approval-request");
      expect(c.sent[0].text).toContain("job-1");
      expect(c.sent[0].text).toContain("task-7");
      expect(c.sent[0].text).toContain("git push origin main");
    }
    n.dispose();
  });

  it("starts sending before any timer advances", () => {
    const hud = fakeSender("hud");
    const n = new Notifier({ channels: [hud.sender] });
    void n.requestApproval(req);
    return Promise.resolve().then(() => {
      expect(hud.calls()).toBe(1);
      n.dispose();
    });
  });

  it("returns the first report for a duplicate request without resending", async () => {
    const hud = fakeSender("hud");
    const n = new Notifier({ channels: [hud.sender] });
    const a = n.requestApproval(req);
    const b = n.requestApproval(req);
    expect(b).toBe(a);
    await a;
    expect(hud.sent).toHaveLength(1);
    n.dispose();
  });
});

describe("per-channel retry (8.5)", () => {
  it("retries a failing channel 3 times, 10s apart, while the other channel is unaffected", async () => {
    const hud = fakeSender("hud", 3);
    const wa = fakeSender("whatsapp");
    const events: NotifierEvent[] = [];
    const n = new Notifier({ channels: [hud.sender, wa.sender], onEvent: (e) => events.push(e) });
    const pending = n.requestApproval(req);

    await vi.advanceTimersByTimeAsync(0);
    expect(wa.sent).toHaveLength(1);
    expect(hud.calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(hud.calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(hud.calls()).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hud.calls()).toBe(3);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hud.calls()).toBe(4);

    const report = await pending;
    const hudResult = report.results.find((r) => r.channel === "hud");
    expect(hudResult).toMatchObject({ delivered: true, attempts: 4 });
    expect(events.filter((e) => e.type === "retry-scheduled")).toHaveLength(3);
    n.dispose();
  });

  it("gives up after 3 retries, reports the failure, and leaves the other channel delivered", async () => {
    const hud = fakeSender("hud", 99);
    const wa = fakeSender("whatsapp");
    const events: NotifierEvent[] = [];
    const n = new Notifier({ channels: [hud.sender, wa.sender], onEvent: (e) => events.push(e) });
    const pending = n.requestApproval(req);
    await vi.advanceTimersByTimeAsync(30_000);
    const report = await pending;
    expect(hud.calls()).toBe(4);
    expect(report.anyDelivered).toBe(true);
    expect(report.results.find((r) => r.channel === "hud")).toMatchObject({
      delivered: false,
      attempts: 4,
      error: "hud down",
    });
    expect(report.results.find((r) => r.channel === "whatsapp")?.delivered).toBe(true);
    expect(events.some((e) => e.type === "channel-failed" && e.channel === "hud")).toBe(true);
    n.dispose();
  });

  it("treats a send that never settles as a failed attempt and retries", async () => {
    let calls = 0;
    const stuck: ChannelSender = {
      channel: "hud",
      send: () => {
        calls++;
        return calls === 1 ? new Promise<void>(() => {}) : Promise.resolve();
      },
    };
    const n = new Notifier({ channels: [stuck], attemptTimeoutMs: 5_000 });
    const pending = n.requestApproval(req);
    await vi.advanceTimersByTimeAsync(5_000 + 10_000);
    const report = await pending;
    expect(report.results[0]).toMatchObject({ delivered: true, attempts: 2 });
    n.dispose();
  });

  it("stops retrying once the decision is applied", async () => {
    const hud = fakeSender("hud", 99);
    const n = new Notifier({ channels: [hud.sender] });
    const pending = n.requestApproval(req);
    await vi.advanceTimersByTimeAsync(0);
    expect(hud.calls()).toBe(1);
    n.decisionApplied(req.jobId, req.taskId);
    const report = await pending;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hud.calls()).toBe(1);
    expect(report.results[0].cancelled).toBe(true);
  });
});

describe("reminders (8.9)", () => {
  it("defaults to 15 minutes and reaches both channels on each interval", async () => {
    const hud = fakeSender("hud");
    const wa = fakeSender("whatsapp");
    const n = new Notifier({ channels: [hud.sender, wa.sender] });
    await n.requestApproval(req);
    await vi.advanceTimersByTimeAsync(DEFAULT_REMINDER_INTERVAL_MS - 1);
    expect(hud.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(hud.sent).toHaveLength(2);
    expect(wa.sent).toHaveLength(2);
    expect(hud.sent[1]).toMatchObject({ kind: "approval-reminder", reminderNumber: 1 });
    expect(hud.sent[1].text).toContain("task-7");
    await vi.advanceTimersByTimeAsync(DEFAULT_REMINDER_INTERVAL_MS);
    expect(hud.sent[2]).toMatchObject({ reminderNumber: 2 });
    n.dispose();
  });

  it("uses a valid configured interval", async () => {
    const hud = fakeSender("hud");
    const n = new Notifier({ channels: [hud.sender], reminderIntervalMs: 60_000 });
    expect(n.reminderIntervalRejected).toBe(false);
    await n.requestApproval(req);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hud.sent).toHaveLength(2);
    n.dispose();
  });

  it("rejects an out-of-range interval and uses the default", () => {
    const n = new Notifier({ channels: [], reminderIntervalMs: 1_000 });
    expect(n.reminderIntervalMs).toBe(DEFAULT_REMINDER_INTERVAL_MS);
    expect(n.reminderIntervalRejected).toBe(true);
  });

  it("sends no reminder after the decision is applied", async () => {
    const hud = fakeSender("hud");
    const wa = fakeSender("whatsapp");
    const events: NotifierEvent[] = [];
    const n = new Notifier({
      channels: [hud.sender, wa.sender],
      reminderIntervalMs: 60_000,
      onEvent: (e) => events.push(e),
    });
    await n.requestApproval(req);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hud.sent).toHaveLength(2);
    expect(n.decisionApplied(req.jobId, req.taskId)).toBe(true);
    expect(n.isPending(req.jobId, req.taskId)).toBe(false);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(hud.sent).toHaveLength(2);
    expect(wa.sent).toHaveLength(2);
    expect(events.some((e) => e.type === "reminders-stopped")).toBe(true);
    expect(n.decisionApplied(req.jobId, req.taskId)).toBe(false);
  });

  it("keeps separate reminder streams per Task", async () => {
    const hud = fakeSender("hud");
    const n = new Notifier({ channels: [hud.sender], reminderIntervalMs: 60_000 });
    await n.requestApproval(req);
    await n.requestApproval({ ...req, taskId: "task-8" });
    n.decisionApplied(req.jobId, req.taskId);
    await vi.advanceTimersByTimeAsync(60_000);
    const reminders = hud.sent.filter((m) => m.kind === "approval-reminder");
    expect(reminders.map((m) => m.taskId)).toEqual(["task-8"]);
    n.dispose();
  });
});

describe("formatApprovalText", () => {
  it("includes the reason only when present", () => {
    expect(formatApprovalText({ jobId: "j", taskId: "t", action: "a" })).not.toContain("Reason");
    expect(formatApprovalText(req)).toContain("Reason: pushes code to a remote");
  });
});

describe("real channel adapters", () => {
  const message: NotificationMessage = {
    kind: "approval-request",
    jobId: "job-1",
    taskId: "task-7",
    action: "git push",
    text: "Approval needed",
    createdAtMs: 1,
  };

  it("HUD adapter broadcasts on the jobs.approval gateway event", async () => {
    const broadcast = vi.fn();
    await createHudChannel(broadcast).send(message);
    expect(broadcast).toHaveBeenCalledWith(
      HUD_APPROVAL_EVENT,
      expect.objectContaining({ jobId: "job-1", taskId: "task-7", action: "git push" }),
      { dropIfSlow: false },
    );
  });

  it("HUD adapter fails when the broadcaster throws", async () => {
    const ch = createHudChannel(() => {
      throw new Error("boom");
    });
    await expect(ch.send(message)).rejects.toThrow("boom");
  });

  it("WhatsApp adapter sends the text to the configured recipient", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: "m1" });
    await createWhatsAppChannel({ to: "+15550100", send, accountId: "acct" }).send(message);
    expect(send).toHaveBeenCalledWith("+15550100", "Approval needed", {
      verbose: false,
      accountId: "acct",
    });
  });

  it("WhatsApp adapter rejects when no recipient is configured", async () => {
    const ch = createWhatsAppChannel({ to: () => undefined, send: vi.fn() });
    await expect(ch.send(message)).rejects.toThrow("recipient");
  });
});
