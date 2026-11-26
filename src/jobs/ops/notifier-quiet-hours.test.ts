import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatDigestText, msUntilDigestDue, resolveDigestSchedule } from "./digest.js";
import {
  type ChannelSender,
  type NotificationMessage,
  Notifier,
  type NotifierOptions,
} from "./notifier.js";
import {
  boundedDelay,
  isQuietAt,
  msUntilQuietEnd,
  resolveQuietHours,
  type QuietHoursConfig,
} from "./quiet-hours.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const req = { jobId: "job-1", taskId: "task-7", action: "git push origin main" };

function fakeSender(channel: string) {
  const sent: NotificationMessage[] = [];
  const sender: ChannelSender = {
    channel,
    async send(message) {
      sent.push(message);
    },
  };
  return { sender, sent };
}

/** 22:00 to 06:00 UTC, spanning midnight. */
const night = (approvals: "allow" | "hold"): QuietHoursConfig => ({
  start: "22:00",
  end: "06:00",
  timezone: "UTC",
  approvals,
});

function setup(options: Partial<NotifierOptions> = {}) {
  const hud = fakeSender("hud");
  const wa = fakeSender("whatsapp");
  const n = new Notifier({ channels: [hud.sender, wa.sender], ...options });
  return { n, hud, wa };
}

const at = (iso: string) => vi.setSystemTime(new Date(iso));

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("quiet-hours window", () => {
  const q = (cfg: QuietHoursConfig) => {
    const r = resolveQuietHours(cfg);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };

  it("spans midnight: active from 22:00 until 06:00 exclusive", () => {
    const w = q(night("hold"));
    const active = (iso: string) => isQuietAt(Date.parse(iso), w);
    expect(active("2025-03-10T21:59:59Z")).toBe(false);
    expect(active("2025-03-10T22:00:00Z")).toBe(true);
    expect(active("2025-03-10T23:59:59Z")).toBe(true);
    expect(active("2025-03-11T00:00:00Z")).toBe(true);
    expect(active("2025-03-11T05:59:59Z")).toBe(true);
    expect(active("2025-03-11T06:00:00Z")).toBe(false);
    expect(active("2025-03-11T12:00:00Z")).toBe(false);
  });

  it("handles a same-day window and an end of 24:00", () => {
    const day = q({ start: "09:00", end: "17:00", timezone: "UTC", approvals: "hold" });
    expect(isQuietAt(Date.parse("2025-03-10T08:59:59Z"), day)).toBe(false);
    expect(isQuietAt(Date.parse("2025-03-10T09:00:00Z"), day)).toBe(true);
    expect(isQuietAt(Date.parse("2025-03-10T17:00:00Z"), day)).toBe(false);
    const late = q({ start: "20:00", end: "24:00", timezone: "UTC", approvals: "hold" });
    expect(isQuietAt(Date.parse("2025-03-10T23:59:59Z"), late)).toBe(true);
    expect(isQuietAt(Date.parse("2025-03-11T00:00:00Z"), late)).toBe(false);
  });

  it("evaluates the window in the configured time zone", () => {
    // Asia/Kolkata is UTC+5:30, so 17:00Z is 22:30 local.
    const w = q({ ...night("hold"), timezone: "Asia/Kolkata" });
    expect(isQuietAt(Date.parse("2025-03-10T17:00:00Z"), w)).toBe(true);
    expect(isQuietAt(Date.parse("2025-03-10T16:29:59Z"), w)).toBe(false);
    expect(msUntilQuietEnd(Date.parse("2025-03-10T17:00:00Z"), w)).toBe(7.5 * HOUR);
  });

  it("computes time to the end across midnight and returns 0 outside the window", () => {
    const w = q(night("hold"));
    expect(msUntilQuietEnd(Date.parse("2025-03-10T23:00:00Z"), w)).toBe(7 * HOUR);
    expect(msUntilQuietEnd(Date.parse("2025-03-11T05:30:00.250Z"), w)).toBe(30 * MIN - 250);
    expect(msUntilQuietEnd(Date.parse("2025-03-11T12:00:00Z"), w)).toBe(0);
  });

  it("rejects bad times, equal start and end, and a bad approval setting", () => {
    for (const bad of [
      { ...night("hold"), start: "25:00" },
      { ...night("hold"), end: "6" },
      { ...night("hold"), start: "24:00" },
      { ...night("hold"), start: "08:00", end: "08:00" },
      { ...night("hold"), approvals: "maybe" as "allow" },
    ]) {
      expect(resolveQuietHours(bad).ok).toBe(false);
    }
  });

  it("keeps wake-ups at most 30s apart near the target", () => {
    expect(boundedDelay(0)).toBe(0);
    expect(boundedDelay(10_000)).toBe(10_000);
    expect(boundedDelay(45 * MIN)).toBe(30_000);
    expect(boundedDelay(5 * HOUR)).toBe(4 * HOUR);
  });
});

describe("non-approval notifications during Quiet_Hours (13.3)", () => {
  it("delivers immediately outside Quiet_Hours", async () => {
    at("2025-03-10T12:00:00Z");
    const { n, hud } = setup({ quietHours: night("hold") });
    expect(n.notify("hello")).toEqual({ held: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(hud.sent.map((m) => m.text)).toEqual(["hello"]);
    n.dispose();
  });

  it("holds across midnight and delivers in generation order within 60s of the end", async () => {
    at("2025-03-10T21:59:00Z");
    const { n, hud, wa } = setup({ quietHours: night("hold") });
    await vi.advanceTimersByTimeAsync(MIN); // 22:00, window opens
    expect(n.isQuietNow()).toBe(true);

    n.notify("first");
    await vi.advanceTimersByTimeAsync(2 * HOUR); // 00:00
    n.notify("second");
    await vi.advanceTimersByTimeAsync(3 * HOUR); // 03:00
    n.notify("third");
    expect(n.heldCount()).toBe(3);

    await vi.advanceTimersByTimeAsync(3 * HOUR - 1); // 05:59:59.999
    expect(hud.sent).toHaveLength(0);
    expect(wa.sent).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(60_000 + 1); // within 60s after 06:00
    for (const c of [hud, wa])
      expect(c.sent.map((m) => m.text)).toEqual(["first", "second", "third"]);
    expect(n.heldCount()).toBe(0);
    n.dispose();
  });

  it("keeps order when a message arrives right after the window ends", async () => {
    at("2025-03-11T05:59:59.900Z");
    const { n, hud } = setup({ quietHours: night("hold") });
    n.notify("held");
    at("2025-03-11T06:00:00.100Z"); // window over, flush timer not yet fired
    n.notify("later");
    await vi.advanceTimersByTimeAsync(0);
    expect(hud.sent.map((m) => m.text)).toEqual(["held", "later"]);
    n.dispose();
  });

  it("does nothing special when the quiet-hours config is invalid", () => {
    at("2025-03-10T23:00:00Z");
    const { n } = setup({ quietHours: { ...night("hold"), start: "nope" } });
    expect(n.quietHoursError).toContain("invalid quiet-hours start");
    expect(n.isQuietNow()).toBe(false);
    expect(n.notify("x")).toEqual({ held: false });
    n.dispose();
  });
});

describe("approval requests during Quiet_Hours (13.4)", () => {
  it('setting "allow" delivers the request immediately inside the window', async () => {
    at("2025-03-11T01:00:00Z");
    const { n, hud, wa } = setup({ quietHours: night("allow") });
    const report = await n.requestApproval(req);
    expect(report.anyDelivered).toBe(true);
    expect(hud.sent).toHaveLength(1);
    expect(wa.sent).toHaveLength(1);
    expect(hud.sent[0].kind).toBe("approval-request");
    n.dispose();
  });

  it('setting "hold" delays the request until the window ends, then delivers within 60s', async () => {
    at("2025-03-11T01:00:00Z");
    const { n, hud, wa } = setup({ quietHours: night("hold") });
    let settled = false;
    const pending = n.requestApproval(req).then((r) => {
      settled = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(5 * HOUR - 1); // 05:59:59.999
    expect(hud.sent).toHaveLength(0);
    expect(settled).toBe(false);
    expect(n.isPending(req.jobId, req.taskId)).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);
    const report = await pending;
    expect(report.anyDelivered).toBe(true);
    expect(hud.sent).toHaveLength(1);
    expect(wa.sent).toHaveLength(1);
    expect(hud.sent[0].text).toContain("task-7");
    n.dispose();
  });

  it('with "hold", no reminders go out during the window and reminders start after release', async () => {
    at("2025-03-11T01:00:00Z");
    const { n, hud } = setup({ quietHours: night("hold"), reminderIntervalMs: 15 * MIN });
    void n.requestApproval(req);
    await vi.advanceTimersByTimeAsync(5 * HOUR - 1);
    expect(hud.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000); // 06:00:00.999, released
    expect(hud.sent.map((m) => m.kind)).toEqual(["approval-request"]);
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(hud.sent.map((m) => m.kind)).toEqual(["approval-request", "approval-reminder"]);
    n.dispose();
  });

  it('with "hold", a decision applied while held cancels delivery', async () => {
    at("2025-03-11T01:00:00Z");
    const { n, hud } = setup({ quietHours: night("hold") });
    const pending = n.requestApproval(req);
    expect(n.heldCount()).toBe(1);
    expect(n.decisionApplied(req.jobId, req.taskId)).toBe(true);
    const report = await pending;
    expect(report.anyDelivered).toBe(false);
    expect(report.results.every((r) => r.cancelled)).toBe(true);
    await vi.advanceTimersByTimeAsync(6 * HOUR);
    expect(hud.sent).toHaveLength(0);
    n.dispose();
  });

  it('with "hold", approvals and notices are released together in generation order', async () => {
    at("2025-03-11T01:00:00Z");
    const { n, hud } = setup({ quietHours: night("hold") });
    n.notify("a");
    void n.requestApproval(req);
    n.notify("b");
    await vi.advanceTimersByTimeAsync(5 * HOUR + 60_000);
    expect(hud.sent.map((m) => m.kind)).toEqual(["notice", "approval-request", "notice"]);
    n.dispose();
  });

  it("delivers approvals normally outside the window regardless of setting", async () => {
    at("2025-03-10T12:00:00Z");
    const { n, hud } = setup({ quietHours: night("hold") });
    await n.requestApproval(req);
    expect(hud.sent).toHaveLength(1);
    n.dispose();
  });
});

describe("Digest (13.2)", () => {
  const digest = { time: "08:00", timezone: "UTC" };

  it("delivers exactly one Digest per day, listing changed Jobs once with the latest status", async () => {
    at("2025-03-10T07:00:00Z");
    const { n, hud, wa } = setup({ digest });
    n.start();
    n.start(); // idempotent
    n.recordJobChange({ jobId: "job-1", status: "running" });
    n.recordJobChange({
      jobId: "job-2",
      status: "done",
      completedAtMs: Date.parse("2025-03-10T06:30:00Z"),
    });
    n.recordJobChange({
      jobId: "job-1",
      status: "done",
      completedAtMs: Date.parse("2025-03-10T07:15:00Z"),
    });

    await vi.advanceTimersByTimeAsync(HOUR - 1); // 07:59:59.999
    expect(hud.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60_000); // within 60s of 08:00
    for (const c of [hud, wa]) {
      expect(c.sent).toHaveLength(1);
      expect(c.sent[0].kind).toBe("digest");
      expect(c.sent[0].entries?.map((e) => [e.jobId, e.status])).toEqual([
        ["job-2", "done"],
        ["job-1", "done"],
      ]);
      expect(c.sent[0].text).toContain("job-1: done (completed 2025-03-10T07:15:00.000Z)");
      expect(c.sent[0].text).toContain("job-2: done (completed 2025-03-10T06:30:00.000Z)");
    }

    // The rest of the day produces no second Digest.
    await vi.advanceTimersByTimeAsync(23 * HOUR - 2 * MIN);
    expect(hud.sent).toHaveLength(1);

    // Next day: one more, containing only changes since the previous Digest.
    n.recordJobChange({ jobId: "job-3", status: "failed" });
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(hud.sent).toHaveLength(2);
    expect(hud.sent[1].entries?.map((e) => e.jobId)).toEqual(["job-3"]);
    n.dispose();
  });

  it("does not deliver an immediate Digest when started after the day's time", async () => {
    at("2025-03-10T09:00:00Z");
    const { n, hud } = setup({ digest });
    n.start();
    await vi.advanceTimersByTimeAsync(22 * HOUR); // 07:00 next day
    expect(hud.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(HOUR + 60_000);
    expect(hud.sent).toHaveLength(1);
    n.dispose();
  });

  it("sends a Digest with no changes as a single short message", async () => {
    at("2025-03-10T07:59:00Z");
    const { n, hud } = setup({ digest });
    n.start();
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(hud.sent).toHaveLength(1);
    expect(hud.sent[0].entries).toEqual([]);
    expect(hud.sent[0].text).toContain("no Job status changes");
    n.dispose();
  });

  it("uses the configured time zone", async () => {
    at("2025-03-10T00:00:00Z");
    // 08:00 in Asia/Kolkata (UTC+5:30) is 02:30Z.
    const { n, hud } = setup({ digest: { time: "08:00", timezone: "Asia/Kolkata" } });
    n.start();
    await vi.advanceTimersByTimeAsync(2.5 * HOUR - 1);
    expect(hud.sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hud.sent).toHaveLength(1);
    n.dispose();
  });

  it("holds a Digest generated during Quiet_Hours and delivers it after they end", async () => {
    at("2025-03-10T21:00:00Z");
    const { n, hud } = setup({
      digest: { time: "23:00", timezone: "UTC" },
      quietHours: night("hold"),
    });
    n.start();
    n.recordJobChange({ jobId: "job-1", status: "done", completedAtMs: Date.now() });
    await vi.advanceTimersByTimeAsync(2 * HOUR + MIN); // past 23:00, inside window
    expect(hud.sent).toHaveLength(0);
    expect(n.heldCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(7 * HOUR); // past 06:00
    expect(hud.sent).toHaveLength(1);
    expect(hud.sent[0].kind).toBe("digest");
    expect(hud.sent[0].entries?.map((e) => e.jobId)).toEqual(["job-1"]);
    n.dispose();
  });

  it("stops the schedule on dispose and rejects an invalid time", async () => {
    at("2025-03-10T07:00:00Z");
    const { n, hud } = setup({ digest });
    n.start();
    n.dispose();
    await vi.advanceTimersByTimeAsync(3 * HOUR);
    expect(hud.sent).toHaveLength(0);

    const bad = setup({ digest: { time: "8am" } });
    expect(bad.n.digestError).toContain("invalid digest time");
    bad.n.start();
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(bad.hud.sent).toHaveLength(0);
  });

  it("computes the wait to the next Digest and its text", () => {
    const s = resolveDigestSchedule({ time: "08:00", timezone: "UTC" });
    if (!s.ok) throw new Error(s.error);
    const t = (iso: string, last?: string) => msUntilDigestDue(Date.parse(iso), s.value, last);
    expect(t("2025-03-10T07:00:00Z")).toBe(HOUR);
    expect(t("2025-03-10T08:00:00Z", "2025-03-09")).toBe(0);
    expect(t("2025-03-10T08:00:00Z", "2025-03-10")).toBe(24 * HOUR);
    expect(t("2025-03-10T15:00:00Z", "2025-03-10")).toBe(17 * HOUR);
    expect(formatDigestText([])).toContain("no Job status changes");
  });
});
