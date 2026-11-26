// Works long jobs one step at a time in the background: plan, do each step in the job's own
// session, check the result against the goal (with one fix round), then tell Sir. Progress is
// saved after every step, so the app closing mid-job only costs the step in flight.
// The model call, Sir notification and HUD broadcast are injected, which keeps this testable.

import fs from "node:fs";

import { createSubsystemLogger } from "../../logging/subsystem.js";
import { type Job, isActive, listJobs, loadJob, saveJob } from "./store.js";

const log = createSubsystemLogger("jobs");

const MAX_STEPS = 8;
const MAX_ATTEMPTS = 2;
const MAX_FIX_ROUNDS = 1;

export type JobDeps = {
  /** One agent turn in the given session; resolves with the reply text. */
  runTurn: (sessionKey: string, message: string) => Promise<string>;
  /** Tell Sir (WhatsApp) about a finished/failed/blocked job. */
  notify: (text: string) => Promise<void>;
  /** Push the job's current state to the HUD. */
  broadcast: (job: Job) => void;
  stateDir?: string;
};

export const jobSessionKey = (id: string) => `agent:main:job:${id}`;

/** First JSON object in a reply (models like to wrap it in prose or fences). */
export function parsePlan(reply: string): string[] {
  const match = reply.match(/\{[\s\S]*\}/);
  if (!match) return [];
  try {
    const steps = (JSON.parse(match[0]) as { steps?: unknown }).steps;
    return Array.isArray(steps)
      ? steps
          .map((s) => String(s).trim())
          .filter(Boolean)
          .slice(0, MAX_STEPS)
      : [];
  } catch {
    return [];
  }
}

/** A step reply: Sir is needed, or what got done. */
export function parseStepReply(reply: string): { needSir?: string; summary: string } {
  const need = reply.match(/NEED SIR:\s*([\s\S]+)/i);
  if (need) return { needSir: need[1].trim(), summary: "" };
  const done = reply.match(/DONE:\s*([\s\S]+)/i);
  return { summary: (done ? done[1] : reply).trim().slice(0, 1500) };
}

function context(job: Job): string {
  const done = job.steps
    .filter((s) => s.status === "done")
    .map((s, i) => `${i + 1}. ${s.title}: ${s.summary ?? ""}`)
    .join("\n");
  return [
    `Background job "${job.title}" (id ${job.id}). Sir is not watching; work on your own.`,
    `Goal from Sir: ${job.goal}`,
    `Save deliverables in ${job.dir}.`,
    job.answers.length
      ? `Sir's answers so far:\n${job.answers.map((a) => `- ${a}`).join("\n")}`
      : "",
    done ? `Done so far:\n${done}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export class JobRunner {
  private busy = false;
  private queued = false;

  constructor(private readonly deps: JobDeps) {}

  /** Work through every active job, one at a time. Safe to call repeatedly. */
  kick(): void {
    if (this.busy) {
      this.queued = true;
      return;
    }
    this.busy = true;
    void (async () => {
      try {
        do {
          this.queued = false;
          for (const job of listJobs(this.deps.stateDir).filter(isActive).reverse())
            await this.work(job.id);
        } while (this.queued);
      } catch (err) {
        log.warn(`job runner stopped: ${String(err)}`);
      } finally {
        this.busy = false;
      }
    })();
  }

  private save(job: Job) {
    saveJob(job, this.deps.stateDir);
    this.deps.broadcast(job);
  }

  /** Re-read before each step so cancel/answers made meanwhile are respected. */
  private fresh(id: string): Job | null {
    const job = loadJob(id, this.deps.stateDir);
    return job && isActive(job) ? job : null;
  }

  private async work(id: string) {
    let job = this.fresh(id);
    if (!job) return;
    fs.mkdirSync(job.dir, { recursive: true });
    const session = jobSessionKey(job.id);

    if (job.status === "planning") {
      const reply = await this.deps
        .runTurn(
          session,
          `${context(job)}\n\nPlan this job as 2-${MAX_STEPS} concrete steps, each one you can finish in one go ` +
            `with your tools. Don't do any of them yet. Reply ONLY with JSON: {"steps": ["...", "..."]}`,
        )
        .catch((err) => `error: ${String(err)}`);
      // Sir may have cancelled while it was planning.
      job = this.fresh(id);
      if (!job) return;
      const steps = parsePlan(reply);
      if (!steps.length)
        return this.finish(job, "failed", `I couldn't plan it (${reply.slice(0, 200)}).`);
      job.steps = steps.map((title) => ({ title, status: "pending", attempts: 0 }));
      job.status = "running";
      this.save(job);
    }

    for (;;) {
      job = this.fresh(id);
      if (!job) return;
      // A step left "running" by a restart is simply done again.
      const step = job.steps.find((s) => s.status === "pending" || s.status === "running");
      if (!step) break;
      const index = job.steps.indexOf(step);
      step.status = "running";
      step.attempts += 1;
      step.startedAt = new Date().toISOString();
      this.save(job);
      const reply = await this.deps
        .runTurn(
          session,
          `${context(job)}\n\nNow do step ${index + 1} of ${job.steps.length}: ${step.title}\n` +
            "Use your tools. If you need something only Sir can give (a decision, a login, an approval), reply " +
            "exactly `NEED SIR: <your question>`. Otherwise end with `DONE: <short summary, with any file paths>`.",
        )
        .catch((err) => {
          log.warn(`job ${id} step ${index + 1} failed: ${String(err)}`);
          return "";
        });
      job = this.fresh(id);
      if (!job) return;
      const current = job.steps[index];
      const parsed = parseStepReply(reply);
      if (parsed.needSir) {
        current.status = "pending";
        current.attempts -= 1; // asking Sir isn't a failed attempt
        job.status = "waiting";
        job.question = parsed.needSir;
        this.save(job);
        await this.deps
          .notify(`⏸️ "${job.title}" needs you, Sir: ${parsed.needSir}`)
          .catch(() => {});
        return;
      }
      if (!reply.trim()) {
        if (current.attempts < MAX_ATTEMPTS) {
          current.status = "pending";
          this.save(job);
          continue;
        }
        current.status = "failed";
        return this.finish(job, "failed", `Step ${index + 1} ("${current.title}") failed twice.`);
      }
      current.status = "done";
      current.summary = parsed.summary;
      current.endedAt = new Date().toISOString();
      this.save(job);
    }

    await this.verify(id);
  }

  private async verify(id: string) {
    const job = this.fresh(id);
    if (!job) return;
    const reply = await this.deps
      .runTurn(
        jobSessionKey(job.id),
        `${context(job)}\n\nAll steps are done. Check the result against Sir's goal: open the files in ${job.dir} ` +
          "and look for anything missing, wrong or unfinished. Fix small problems yourself. Then reply " +
          "`VERIFIED: <2-4 sentence report for Sir, naming the files>` or `ISSUES: <what's still wrong>`.",
      )
      .catch(() => "");
    const verified = reply.match(/VERIFIED:\s*([\s\S]+)/i);
    if (verified) return this.finish(job, "done", verified[1].trim());
    const issues = reply.match(/ISSUES:\s*([\s\S]+)/i)?.[1]?.trim() || "the check didn't complete";
    if (job.fixRounds < MAX_FIX_ROUNDS) {
      job.fixRounds += 1;
      job.steps.push({
        title: `Fix what the check found: ${issues.slice(0, 300)}`,
        status: "pending",
        attempts: 0,
      });
      this.save(job);
      return this.work(id);
    }
    return this.finish(job, "done", `Finished, with something left for you to check: ${issues}`);
  }

  private async finish(job: Job, status: "done" | "failed", report: string) {
    job.status = status;
    job.report = report;
    job.question = undefined;
    this.save(job);
    const head =
      status === "done" ? `✅ Done, Sir: "${job.title}"` : `⚠️ "${job.title}" didn't finish`;
    await this.deps
      .notify(`${head}\n${report}`)
      .catch((err) => log.warn(`job notify failed: ${String(err)}`));
  }
}
