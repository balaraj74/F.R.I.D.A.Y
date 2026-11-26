import { Type } from "@sinclair/typebox";

import { type Job, listJobs, loadJob, newJob, saveJob } from "../jobs/store.js";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const ACTIONS = ["start", "list", "status", "answer", "cancel"] as const;

// The gateway's job runner registers itself here; tools only queue work and wake it up.
let wake: (() => void) | null = null;
export function setJobWaker(fn: (() => void) | null) {
  wake = fn;
}

const brief = (j: Job) => ({
  id: j.id,
  title: j.title,
  status: j.status,
  progress: `${j.steps.filter((s) => s.status === "done").length}/${j.steps.length || "?"} steps`,
  ...(j.question ? { question: j.question } : {}),
  ...(j.report ? { report: j.report } : {}),
});

const JobsSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      "start = run a big task in the background (plan, steps, self-check, WhatsApp report when done); " +
      "list = recent jobs; status = one job's steps; answer = give a waiting job Sir's answer; cancel = stop a job",
  }),
  title: Type.Optional(Type.String({ description: "start: short name, e.g. 'DBMS lab report'" })),
  goal: Type.Optional(
    Type.String({
      description:
        "start: everything the job needs: what Sir wants, the format, where inputs are, deadlines, how to deliver",
    }),
  ),
  id: Type.Optional(Type.String({ description: "status/answer/cancel: job id" })),
  answer: Type.Optional(Type.String({ description: "answer: Sir's reply to the job's question" })),
});

export function createJobsTool(options: { workspaceDir?: string } = {}): AnyAgentTool {
  return {
    label: "Jobs",
    name: "jobs",
    description:
      "Background jobs for big multi-step work that would take more than a few minutes (write a report, research a " +
      "topic and make slides, refactor a project). The job plans itself, works step by step even if the app restarts, " +
      "checks its own result and messages Sir on WhatsApp when done or when it needs him. Start one, tell Sir it's " +
      "running, and carry on talking. For quick tasks just do them directly.",
    parameters: JobsSchema,
    execute: async (_toolCallId, params) => {
      const action = readStringParam(params, "action", { required: true });
      if (action === "list") return jsonResult({ jobs: listJobs().slice(0, 10).map(brief) });
      if (action === "start") {
        if (!options.workspaceDir) throw new Error("Jobs need FRIDAY's workspace folder.");
        const job = saveJob(
          newJob({
            title: readStringParam(params, "title", { required: true }),
            goal: readStringParam(params, "goal", { required: true }),
            workspaceDir: options.workspaceDir,
          }),
        );
        wake?.();
        return jsonResult({ started: brief(job), files: job.dir });
      }
      const id = readStringParam(params, "id", { required: true });
      const job = loadJob(id);
      if (!job) throw new Error(`No job ${id}`);
      if (action === "status")
        return jsonResult({ ...brief(job), steps: job.steps, files: job.dir });
      if (action === "answer") {
        if (job.status !== "waiting")
          throw new Error(`Job ${id} isn't waiting for an answer (${job.status}).`);
        job.answers.push(
          `${job.question} -> ${readStringParam(params, "answer", { required: true })}`,
        );
        job.question = undefined;
        job.status = "running";
        saveJob(job);
        wake?.();
        return jsonResult({ resumed: brief(job) });
      }
      if (action === "cancel") {
        if (job.status === "done" || job.status === "failed")
          return jsonResult({ already: brief(job) });
        job.status = "cancelled";
        saveJob(job);
        return jsonResult({ cancelled: brief(job) });
      }
      throw new Error(`Unknown action: ${action}`);
    },
  };
}
