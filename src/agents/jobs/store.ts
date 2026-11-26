// Long jobs: a big request ("write my lab report", "research X and make slides") becomes a
// planned list of steps that FRIDAY works through in the background. Each job is one JSON file
// under the state dir, rewritten after every step, so a restart resumes where it stopped.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "../../config/paths.js";

export type StepStatus = "pending" | "running" | "done" | "failed";
export type JobStatus = "planning" | "running" | "waiting" | "done" | "failed" | "cancelled";

export type JobStep = {
  title: string;
  status: StepStatus;
  summary?: string;
  attempts: number;
  startedAt?: string;
  endedAt?: string;
};

export type Job = {
  id: string;
  title: string;
  goal: string;
  status: JobStatus;
  steps: JobStep[];
  /** Where the job saves its deliverables (inside FRIDAY's workspace). */
  dir: string;
  createdAt: string;
  updatedAt: string;
  /** What FRIDAY is waiting for Sir to answer (status "waiting"). */
  question?: string;
  /** Sir's answers so far, passed to every later step. */
  answers: string[];
  /** Fix rounds used after verification found problems. */
  fixRounds: number;
  /** The final report for Sir (done/failed). */
  report?: string;
};

const jobsDir = (stateDir = resolveStateDir()) => path.join(stateDir, "jobs");

export function newJob(params: { title: string; goal: string; workspaceDir: string }): Job {
  const id = `j_${crypto.randomBytes(4).toString("hex")}`;
  const now = new Date().toISOString();
  return {
    id,
    title: params.title.trim().slice(0, 120),
    goal: params.goal.trim(),
    status: "planning",
    steps: [],
    dir: path.join(params.workspaceDir, "jobs", id),
    createdAt: now,
    updatedAt: now,
    answers: [],
    fixRounds: 0,
  };
}

export function saveJob(job: Job, stateDir?: string): Job {
  job.updatedAt = new Date().toISOString();
  const dir = jobsDir(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${job.id}.json`);
  // Write-then-rename so a crash mid-write never leaves a half job file.
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(job, null, 2));
  fs.renameSync(`${file}.tmp`, file);
  return job;
}

export function loadJob(id: string, stateDir?: string): Job | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(jobsDir(stateDir), `${id}.json`), "utf-8")) as Job;
  } catch {
    return null;
  }
}

export function listJobs(stateDir?: string): Job[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(jobsDir(stateDir)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  return files
    .map((f) => loadJob(f.slice(0, -5), stateDir))
    .filter((j): j is Job => j !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export const isActive = (job: Job) => job.status === "planning" || job.status === "running";
