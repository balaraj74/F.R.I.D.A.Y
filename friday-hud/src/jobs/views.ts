// Pure helpers for the Jobs_Views (Requirements 12.1 and 12.5). No styling, no React.
import type { JobState, JobView } from './types';

export type BoardColumn = 'running' | 'waiting' | 'done';

/**
 * Board column for a Job state (Req 12.1). Every state maps to exactly one column.
 *
 *   running: pending, running, verifying   (the engine is working, or about to)
 *   waiting: waiting_approval, paused      (blocked until the user acts)
 *   done:    done, failed, cancelled       (terminal)
 */
export function boardColumnFor(state: JobState): BoardColumn {
  switch (state) {
    case 'pending':
    case 'running':
    case 'verifying':
      return 'running';
    case 'waiting_approval':
    case 'paused':
      return 'waiting';
    case 'done':
    case 'failed':
    case 'cancelled':
      return 'done';
    default: {
      const unreachable: never = state;
      throw new Error(`Unknown job state: ${String(unreachable)}`);
    }
  }
}

export type CostRollup = {
  jobTotal: number;
  perTask: Record<string, number>;
};

/**
 * Token rollup for a Job (Req 12.5). The Event_Log records tokens, not currency, so the
 * unit is `usage.totalTokens`. `jobTotal` is the sum of `perTask` by construction, so the
 * Job total always equals the sum of its Task values.
 */
export function costRollup(job: Pick<JobView, 'tasks'>): CostRollup {
  const perTask: Record<string, number> = {};
  let jobTotal = 0;
  for (const [id, task] of Object.entries(job.tasks)) {
    const tokens = task.usage.totalTokens;
    perTask[id] = tokens;
    jobTotal += tokens;
  }
  return { jobTotal, perTask };
}
