// Jobs_API request and response schemas (Requirement 11.10).
// Every method has a params schema, a success schema and shares one error schema. The
// contract tests validate requests, responses and error responses against these.
import { type Static, type TSchema, Type } from "@sinclair/typebox";

import { JOB_STATES, TASK_STATES } from "../../jobs/store/types.js";

export const JOBS_API_METHODS = {
  create: "job.create",
  list: "job.list",
  show: "job.show",
  pause: "job.pause",
  resume: "job.resume",
  cancel: "job.cancel",
  replay: "job.replay",
  digest: "job.digest",
} as const;
export type JobsApiMethod = (typeof JOBS_API_METHODS)[keyof typeof JOBS_API_METHODS];

export const LIST_PAGE_MAX = 100;
export const GOAL_MAX_LENGTH = 20_000;
export const CONCURRENCY_MIN = 1;
export const CONCURRENCY_MAX = 16;

// RPC protocol schemas use Union of Literals (see gateway/protocol/schema/cron.ts). Unlike
// `Type.Unsafe` enums, these can be checked by `@sinclair/typebox/value` in the handlers.
function stringEnum<const T extends readonly string[]>(values: T): TSchema & { static: T[number] } {
  return Type.Union(values.map((v) => Type.Literal(v))) as unknown as TSchema & {
    static: T[number];
  };
}

const JobIdSchema = Type.String({ minLength: 1, maxLength: 256 });
const JobStateSchema = stringEnum(JOB_STATES);
const TaskStateSchema = stringEnum(TASK_STATES);
const JobTypeSchema = stringEnum(["coding", "research", "operations"] as const);
const EpochMsSchema = Type.Integer();

// --- Errors ---------------------------------------------------------------------------

export const JobsApiErrorSchema = Type.Object(
  {
    code: stringEnum(["validation", "not_found", "invalid_transition"] as const),
    message: Type.String({ minLength: 1 }),
    /** First invalid field (validation errors). */
    field: Type.Optional(Type.String({ minLength: 1 })),
    /** Every invalid field (validation errors), so a client can name them all. */
    fields: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
    jobId: Type.Optional(Type.String({ minLength: 1 })),
    currentState: Type.Optional(JobStateSchema),
  },
  { additionalProperties: false },
);
export type JobsApiError = Static<typeof JobsApiErrorSchema>;

// --- Shared shapes --------------------------------------------------------------------

export const UsageSchema = Type.Object(
  {
    inputTokens: Type.Number({ minimum: 0 }),
    outputTokens: Type.Number({ minimum: 0 }),
    totalTokens: Type.Number({ minimum: 0 }),
    elapsedMs: Type.Number({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const JobSummarySchema = Type.Object(
  {
    id: JobIdSchema,
    type: Type.Optional(JobTypeSchema),
    goal: Type.Optional(Type.String()),
    state: JobStateSchema,
    stateReason: Type.Optional(Type.String()),
    createdAtMs: EpochMsSchema,
    updatedAtMs: EpochMsSchema,
    taskCount: Type.Integer({ minimum: 0 }),
    usage: UsageSchema,
  },
  { additionalProperties: false },
);
export type JobSummary = Static<typeof JobSummarySchema>;

/**
 * Event and timeline entries follow the `CacheTraceEvent` shape in src/agents/cache-trace.ts:
 * `ts` (ISO string), `seq` (monotonic number) and a `scope:phase` `stage`. Job events add
 * their identifiers and original payload.
 */
export const JobTraceEventSchema = Type.Object(
  {
    ts: Type.String({ minLength: 1 }),
    seq: Type.Integer({ minimum: 0 }),
    stage: Type.String({ minLength: 1 }),
    jobId: JobIdSchema,
    taskId: Type.Optional(Type.String()),
    stepId: Type.Optional(Type.String()),
    type: Type.String({ minLength: 1 }),
    createdAtMs: Type.Integer(),
    payload: Type.Unknown(),
  },
  { additionalProperties: false },
);
export type JobTraceEvent = Static<typeof JobTraceEventSchema>;

export const JobTimelineEntrySchema = Type.Object(
  {
    ts: Type.String({ minLength: 1 }),
    seq: Type.Integer({ minimum: 0 }),
    stage: Type.String({ minLength: 1 }),
    type: Type.String({ minLength: 1 }),
    taskId: Type.Optional(Type.String()),
    stepId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type JobTimelineEntry = Static<typeof JobTimelineEntrySchema>;

export const JobTaskViewSchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    role: Type.Optional(Type.String()),
    dependsOn: Type.Array(Type.String()),
    state: TaskStateSchema,
    stateReason: Type.Optional(Type.String()),
    usage: UsageSchema,
  },
  { additionalProperties: false },
);

export const JobDetailSchema = Type.Object(
  {
    ...JobSummarySchema.properties,
    tasks: Type.Array(JobTaskViewSchema),
    timeline: Type.Array(JobTimelineEntrySchema),
  },
  { additionalProperties: false },
);
export type JobDetail = Static<typeof JobDetailSchema>;

export const DigestEntrySchema = Type.Object(
  {
    jobId: JobIdSchema,
    status: JobStateSchema,
    completedAtMs: Type.Optional(EpochMsSchema),
    changedAtMs: EpochMsSchema,
  },
  { additionalProperties: false },
);

// --- Params ---------------------------------------------------------------------------

export const JobCreateParamsSchema = Type.Object(
  {
    // `\S` rejects a goal that is only whitespace.
    goal: Type.String({ minLength: 1, maxLength: GOAL_MAX_LENGTH, pattern: "\\S" }),
    type: Type.Optional(JobTypeSchema),
    concurrencyLimit: Type.Optional(
      Type.Integer({ minimum: CONCURRENCY_MIN, maximum: CONCURRENCY_MAX }),
    ),
  },
  { additionalProperties: false },
);
export type JobCreateParams = Static<typeof JobCreateParamsSchema>;

export const JobListParamsSchema = Type.Object(
  {
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: LIST_PAGE_MAX })),
  },
  { additionalProperties: false },
);
export type JobListParams = Static<typeof JobListParamsSchema>;

/** show, pause, resume, cancel and replay all take just a Job id. */
export const JobIdParamsSchema = Type.Object(
  { jobId: JobIdSchema },
  { additionalProperties: false },
);
export type JobIdParams = Static<typeof JobIdParamsSchema>;

export const JobDigestParamsSchema = Type.Object(
  { sinceMs: Type.Optional(Type.Integer({ minimum: 0 })) },
  { additionalProperties: false },
);
export type JobDigestParams = Static<typeof JobDigestParamsSchema>;

// --- Results --------------------------------------------------------------------------

export const JobCreateResultSchema = Type.Object(
  { job: JobSummarySchema },
  { additionalProperties: false },
);
export const JobListResultSchema = Type.Object(
  {
    jobs: Type.Array(JobSummarySchema, { maxItems: LIST_PAGE_MAX }),
    hasMore: Type.Boolean(),
    nextCursor: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
export const JobShowResultSchema = Type.Object(
  { job: JobDetailSchema },
  { additionalProperties: false },
);
/** pause, resume and cancel return the Job after the change. */
export const JobControlResultSchema = Type.Object(
  { job: JobSummarySchema },
  { additionalProperties: false },
);
export const JobReplayResultSchema = Type.Object(
  { jobId: JobIdSchema, events: Type.Array(JobTraceEventSchema) },
  { additionalProperties: false },
);
export const JobDigestResultSchema = Type.Object(
  {
    entries: Type.Array(DigestEntrySchema),
    text: Type.String(),
    generatedAtMs: EpochMsSchema,
  },
  { additionalProperties: false },
);

export type JobCreateResult = Static<typeof JobCreateResultSchema>;
export type JobListResult = Static<typeof JobListResultSchema>;
export type JobShowResult = Static<typeof JobShowResultSchema>;
export type JobControlResult = Static<typeof JobControlResultSchema>;
export type JobReplayResult = Static<typeof JobReplayResultSchema>;
export type JobDigestResult = Static<typeof JobDigestResultSchema>;

/** Per method: the params schema and the success-result schema. Errors share one schema. */
export const JOBS_API_SCHEMAS = {
  [JOBS_API_METHODS.create]: { params: JobCreateParamsSchema, result: JobCreateResultSchema },
  [JOBS_API_METHODS.list]: { params: JobListParamsSchema, result: JobListResultSchema },
  [JOBS_API_METHODS.show]: { params: JobIdParamsSchema, result: JobShowResultSchema },
  [JOBS_API_METHODS.pause]: { params: JobIdParamsSchema, result: JobControlResultSchema },
  [JOBS_API_METHODS.resume]: { params: JobIdParamsSchema, result: JobControlResultSchema },
  [JOBS_API_METHODS.cancel]: { params: JobIdParamsSchema, result: JobControlResultSchema },
  [JOBS_API_METHODS.replay]: { params: JobIdParamsSchema, result: JobReplayResultSchema },
  [JOBS_API_METHODS.digest]: { params: JobDigestParamsSchema, result: JobDigestResultSchema },
} as const;
