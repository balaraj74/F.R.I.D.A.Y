// `friday jobs ...` command group (Requirement 11.2, 11.3, 11.8). Each subcommand calls the
// matching Jobs_API Gateway RPC method (src/gateway/rpc/jobs.schema.ts). Errors go to stderr
// and set a non-zero exit code, including a Gateway that does not answer within 10 seconds.

import type { Command } from "commander";
import { JOBS_API_METHODS } from "../gateway/rpc/jobs.schema.js";
import type {
  JobControlResult,
  JobCreateParams,
  JobCreateResult,
  JobDetail,
  JobDigestResult,
  JobListParams,
  JobListResult,
  JobReplayResult,
  JobShowResult,
  JobSummary,
  JobTraceEvent,
  JobsApiError,
} from "../gateway/rpc/jobs.schema.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";

/** Requirement 11.8: give up on the Gateway after 10 seconds. */
export const JOBS_GATEWAY_TIMEOUT_MS = 10_000;

export const JOB_TYPES = ["coding", "research", "operations"] as const;
export type JobCliType = (typeof JOB_TYPES)[number];

export type JobsGatewayRequest = {
  method: string;
  params?: unknown;
  timeoutMs: number;
  url?: string;
  token?: string;
};

/** Everything with side effects, injectable so tests need no Gateway. */
export type JobsCliDeps = {
  runtime: Pick<RuntimeEnv, "log" | "error" | "exit">;
  /** Sends one Gateway RPC request. Rejects with the Gateway error (see `details`). */
  callGateway: (req: JobsGatewayRequest) => Promise<unknown>;
  /** Overrides the 10 second timeout; tests only. */
  timeoutMs?: number;
  /** Local Health_Monitor self-check. Rejects when the monitor cannot load or probe. */
  checkHealth?: () => Promise<{ freeDiskBytes: number }>;
};

export type JobsConnectionOptions = { url?: string; token?: string; json?: boolean };
export type JobsCreateOptions = JobsConnectionOptions & { type?: string };
export type JobsListOptions = JobsConnectionOptions & { cursor?: string; limit?: string };
export type JobsDigestOptions = JobsConnectionOptions & { since?: string };

export function createDefaultJobsCliDeps(): JobsCliDeps {
  return {
    runtime: defaultRuntime,
    // Loaded lazily so the installer's check stays cheap; needs no Gateway.
    checkHealth: async () => {
      const [{ HealthMonitor, createDiskFreeProbe }, os] = await Promise.all([
        import("../jobs/ops/health.js"),
        import("node:os"),
      ]);
      if (typeof HealthMonitor !== "function") throw new Error("HealthMonitor is not available.");
      return { freeDiskBytes: await createDiskFreeProbe(os.tmpdir())() };
    },
    // Loaded lazily so `friday jobs --help` stays cheap.
    callGateway: async (req) => {
      const [{ callGateway }, { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES }] = await Promise.all([
        import("../gateway/call.js"),
        import("../utils/message-channel.js"),
      ]);
      return await callGateway({
        method: req.method,
        params: req.params,
        timeoutMs: req.timeoutMs,
        url: req.url,
        token: req.token,
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
      });
    },
  };
}

// ---------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------

class JobsCliTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Gateway did not respond within ${Math.round(timeoutMs / 1000)} seconds.`);
    this.name = "JobsCliTimeoutError";
  }
}

class JobsCliUsageError extends Error {}

const API_ERROR_CODES = new Set(["validation", "not_found", "invalid_transition"]);

/** The Jobs_API error the Gateway attached as `details`, when there is one. */
function readJobsApiError(err: unknown): JobsApiError | undefined {
  const details = (err as { details?: unknown } | null)?.details;
  if (!details || typeof details !== "object") return undefined;
  const d = details as Record<string, unknown>;
  if (typeof d.code !== "string" || !API_ERROR_CODES.has(d.code)) return undefined;
  if (typeof d.message !== "string") return undefined;
  return d as JobsApiError;
}

/** Lines for stderr: code and message, then field, jobId and current state when present. */
export function formatJobsError(err: unknown): string[] {
  const api = readJobsApiError(err);
  if (api) {
    const lines = [`Error (${api.code}): ${api.message}`];
    const fields = api.fields && api.fields.length > 0 ? api.fields : api.field ? [api.field] : [];
    if (fields.length > 0) lines.push(`  field: ${fields.join(", ")}`);
    if (api.jobId) lines.push(`  job: ${api.jobId}`);
    if (api.currentState) lines.push(`  current state: ${api.currentState}`);
    return lines;
  }
  if (err instanceof JobsCliTimeoutError) return [`Error: ${err.message}`];
  const message = err instanceof Error ? err.message : String(err);
  return [`Error: ${message}`];
}

// ---------------------------------------------------------------------------------------
// Calling the Gateway
// ---------------------------------------------------------------------------------------

/** Calls one method, failing with a timeout error if nothing comes back in time. */
async function request<T>(
  deps: JobsCliDeps,
  conn: JobsConnectionOptions,
  method: string,
  params?: unknown,
): Promise<T> {
  const timeoutMs = deps.timeoutMs ?? JOBS_GATEWAY_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new JobsCliTimeoutError(timeoutMs)), timeoutMs);
  });
  try {
    const call = deps.callGateway({
      method,
      params,
      timeoutMs,
      ...(conn.url ? { url: conn.url } : {}),
      ...(conn.token ? { token: conn.token } : {}),
    });
    // If the timeout wins, a late rejection from the call must not become unhandled.
    call.catch(() => undefined);
    return (await Promise.race([call, timeout])) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Runs one command body and maps any failure to stderr output and exit code 1. */
async function runCommand(deps: JobsCliDeps, body: () => Promise<void>): Promise<number> {
  try {
    await body();
    return 0;
  } catch (err) {
    for (const line of formatJobsError(err)) deps.runtime.error(line);
    return 1;
  }
}

// ---------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------

function isoTime(ms: number): string {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : String(ms);
}

function oneLine(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function formatJobRow(job: JobSummary): string {
  const goal = job.goal ? `  ${oneLine(job.goal)}` : "";
  return `${job.id}  ${job.state}  ${job.type ?? "-"}  ${isoTime(job.createdAtMs)}${goal}`;
}

function summaryLines(job: JobSummary): string[] {
  const lines = [
    `Job:      ${job.id}`,
    `State:    ${job.state}${job.stateReason ? ` (${job.stateReason})` : ""}`,
  ];
  if (job.type) lines.push(`Type:     ${job.type}`);
  if (job.goal) lines.push(`Goal:     ${oneLine(job.goal, 200)}`);
  lines.push(
    `Created:  ${isoTime(job.createdAtMs)}`,
    `Updated:  ${isoTime(job.updatedAtMs)}`,
    `Tasks:    ${job.taskCount}`,
    `Usage:    ${job.usage.totalTokens} tokens (${job.usage.inputTokens} in, ${job.usage.outputTokens} out), ${job.usage.elapsedMs} ms`,
  );
  return lines;
}

export function formatJobDetail(job: JobDetail): string[] {
  const lines = summaryLines(job);
  if (job.tasks.length > 0) {
    lines.push("", "Tasks:");
    for (const task of job.tasks) {
      const deps = task.dependsOn.length > 0 ? ` after ${task.dependsOn.join(", ")}` : "";
      const role = task.role ? ` [${task.role}]` : "";
      const reason = task.stateReason ? ` (${task.stateReason})` : "";
      lines.push(`  ${task.id}${role}  ${task.state}${reason}${deps}`);
    }
  }
  if (job.timeline.length > 0) {
    lines.push("", "Timeline:");
    for (const entry of job.timeline) {
      const where = [entry.taskId, entry.stepId].filter(Boolean).join("/");
      lines.push(`  ${entry.ts}  ${entry.stage}  ${entry.type}${where ? `  ${where}` : ""}`);
    }
  }
  return lines;
}

/** One event per line: timestamp, sequence, stage, ids and the payload as JSON. */
export function formatReplayEvent(event: JobTraceEvent): string {
  const parts = [event.ts, `#${event.seq}`, event.stage, `job=${event.jobId}`];
  if (event.taskId) parts.push(`task=${event.taskId}`);
  if (event.stepId) parts.push(`step=${event.stepId}`);
  if (event.payload !== undefined) parts.push(JSON.stringify(event.payload) ?? "");
  return parts.join(" ");
}

/** Ascending by event timestamp, ties broken by sequence (Requirement 11.3). */
export function sortReplayEvents(events: readonly JobTraceEvent[]): JobTraceEvent[] {
  return [...events].sort((a, b) => a.createdAtMs - b.createdAtMs || a.seq - b.seq);
}

// ---------------------------------------------------------------------------------------
// Commands (exposed for tests; each resolves to the process exit code)
// ---------------------------------------------------------------------------------------

function printJson(deps: JobsCliDeps, value: unknown): void {
  deps.runtime.log(JSON.stringify(value, null, 2));
}

function parseNonNegativeInt(name: string, raw: string): number {
  if (!/^\d+$/.test(raw.trim())) {
    throw new JobsCliUsageError(`${name} must be a non-negative integer, got "${raw}".`);
  }
  return Number(raw);
}

export async function runJobsCreate(
  goal: string,
  opts: JobsCreateOptions,
  deps: JobsCliDeps,
): Promise<number> {
  return await runCommand(deps, async () => {
    const params: JobCreateParams = { goal };
    if (opts.type !== undefined) {
      if (!(JOB_TYPES as readonly string[]).includes(opts.type)) {
        throw new JobsCliUsageError(
          `--type must be one of ${JOB_TYPES.join(", ")}, got "${opts.type}".`,
        );
      }
      params.type = opts.type as JobCliType;
    }
    const res = await request<JobCreateResult>(deps, opts, JOBS_API_METHODS.create, params);
    if (opts.json) return printJson(deps, res);
    deps.runtime.log(`Created job ${res.job.id} (${res.job.state})`);
  });
}

export async function runJobsList(opts: JobsListOptions, deps: JobsCliDeps): Promise<number> {
  return await runCommand(deps, async () => {
    const params: JobListParams = {};
    if (opts.cursor) params.cursor = opts.cursor;
    if (opts.limit !== undefined) params.limit = parseNonNegativeInt("--limit", opts.limit);
    const res = await request<JobListResult>(deps, opts, JOBS_API_METHODS.list, params);
    if (opts.json) return printJson(deps, res);
    if (res.jobs.length === 0) {
      deps.runtime.log("No jobs.");
      return;
    }
    // The Jobs_API returns newest first; print in that order.
    for (const job of res.jobs) deps.runtime.log(formatJobRow(job));
    if (res.hasMore && res.nextCursor) {
      deps.runtime.log(
        `More jobs available. Next page: friday jobs list --cursor ${res.nextCursor}`,
      );
    }
  });
}

export async function runJobsShow(
  jobId: string,
  opts: JobsConnectionOptions,
  deps: JobsCliDeps,
): Promise<number> {
  return await runCommand(deps, async () => {
    const res = await request<JobShowResult>(deps, opts, JOBS_API_METHODS.show, { jobId });
    if (opts.json) return printJson(deps, res);
    for (const line of formatJobDetail(res.job)) deps.runtime.log(line);
  });
}

type ControlAction = "pause" | "resume" | "cancel";
const CONTROL_PAST_TENSE: Record<ControlAction, string> = {
  pause: "Paused",
  resume: "Resumed",
  cancel: "Cancelled",
};

const CONTROL_DESCRIPTION: Record<ControlAction, string> = {
  pause: "Pause a running Job",
  resume: "Resume a paused Job",
  cancel: "Cancel a Job",
};

export async function runJobsControl(
  action: ControlAction,
  jobId: string,
  opts: JobsConnectionOptions,
  deps: JobsCliDeps,
): Promise<number> {
  return await runCommand(deps, async () => {
    const res = await request<JobControlResult>(deps, opts, JOBS_API_METHODS[action], { jobId });
    if (opts.json) return printJson(deps, res);
    deps.runtime.log(`${CONTROL_PAST_TENSE[action]} job ${res.job.id} (${res.job.state})`);
  });
}

export async function runJobsReplay(
  jobId: string,
  opts: JobsConnectionOptions,
  deps: JobsCliDeps,
): Promise<number> {
  return await runCommand(deps, async () => {
    const res = await request<JobReplayResult>(deps, opts, JOBS_API_METHODS.replay, { jobId });
    const events = sortReplayEvents(res.events);
    if (opts.json) return printJson(deps, { ...res, events });
    for (const event of events) deps.runtime.log(formatReplayEvent(event));
  });
}

export async function runJobsDigest(opts: JobsDigestOptions, deps: JobsCliDeps): Promise<number> {
  return await runCommand(deps, async () => {
    const params: { sinceMs?: number } = {};
    if (opts.since !== undefined) params.sinceMs = parseNonNegativeInt("--since", opts.since);
    const res = await request<JobDigestResult>(deps, opts, JOBS_API_METHODS.digest, params);
    if (opts.json) return printJson(deps, res);
    deps.runtime.log(res.text);
  });
}

/** Local self-check of the Health_Monitor: it loads and its disk probe answers. No Gateway needed. */
export async function runJobsHealth(
  opts: { json?: boolean },
  deps: JobsCliDeps,
): Promise<number> {
  return await runCommand(deps, async () => {
    if (!deps.checkHealth) throw new Error("Health monitor check is not available.");
    const res = await deps.checkHealth();
    if (opts.json) return printJson(deps, { ok: true, ...res });
    deps.runtime.log(`Health monitor OK (free disk: ${res.freeDiskBytes} bytes)`);
  });
}

// ---------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------

function withConnectionOptions(cmd: Command): Command {
  return cmd
    .option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)")
    .option("--token <token>", "Gateway token (if required)")
    .option("--json", "Output JSON", false);
}

function exitOnFailure(deps: JobsCliDeps, code: number): void {
  if (code !== 0) deps.runtime.exit(code);
}

export function registerJobsCli(
  program: Command,
  deps: JobsCliDeps = createDefaultJobsCliDeps(),
): Command {
  const jobs = program
    .command("jobs")
    .description("Long-running Jobs: create, list, inspect, control and replay");

  withConnectionOptions(
    jobs
      .command("create")
      .description("Create a Job from a goal")
      .argument("<goal>", "What the Job should achieve")
      .option("--type <type>", `Job type: ${JOB_TYPES.join(" | ")}`),
  ).action(async (goal: string, opts: JobsCreateOptions) =>
    exitOnFailure(deps, await runJobsCreate(goal, opts, deps)),
  );

  withConnectionOptions(
    jobs
      .command("list")
      .description("List Jobs, newest first")
      .option("--cursor <cursor>", "Resume after the cursor printed by the previous page")
      .option("--limit <n>", "Jobs per page (1-100)"),
  ).action(async (opts: JobsListOptions) => exitOnFailure(deps, await runJobsList(opts, deps)));

  withConnectionOptions(
    jobs.command("show").description("Show a Job with its tasks and timeline").argument("<id>"),
  ).action(async (id: string, opts: JobsConnectionOptions) =>
    exitOnFailure(deps, await runJobsShow(id, opts, deps)),
  );

  for (const action of ["pause", "resume", "cancel"] as const) {
    withConnectionOptions(
      jobs.command(action).description(CONTROL_DESCRIPTION[action]).argument("<id>"),
    ).action(async (id: string, opts: JobsConnectionOptions) =>
      exitOnFailure(deps, await runJobsControl(action, id, opts, deps)),
    );
  }

  withConnectionOptions(
    jobs
      .command("replay")
      .description("Print every event of a Job in ascending timestamp order")
      .argument("<id>"),
  ).action(async (id: string, opts: JobsConnectionOptions) =>
    exitOnFailure(deps, await runJobsReplay(id, opts, deps)),
  );

  withConnectionOptions(
    jobs
      .command("digest")
      .description("Summarise Jobs that changed state")
      .option("--since <ms>", "Only Jobs changed since this epoch time in milliseconds"),
  ).action(async (opts: JobsDigestOptions) => exitOnFailure(deps, await runJobsDigest(opts, deps)));

  jobs
    .command("health")
    .description("Check that the Health_Monitor loads and can probe (local, no Gateway needed)")
    .option("--json", "Output JSON", false)
    .action(async (opts: { json?: boolean }) =>
      exitOnFailure(deps, await runJobsHealth(opts, deps)),
    );

  return jobs;
}
