import { describe, expect, it } from 'vitest';
import { JOB_STATES } from './types';
import type { JobView, TaskView, UsageTotals } from './types';
import { boardColumnFor, costRollup } from './views';

const usage = (tokens: number): UsageTotals => ({
  inputTokens: tokens,
  outputTokens: 0,
  totalTokens: tokens,
  elapsedMs: 0,
});

const task = (id: string, tokens: number): TaskView => ({
  id,
  jobId: 'j1',
  dependsOn: [],
  state: 'done',
  usage: usage(tokens),
});

describe('boardColumnFor', () => {
  it.each([
    ['pending', 'running'],
    ['running', 'running'],
    ['verifying', 'running'],
    ['waiting_approval', 'waiting'],
    ['paused', 'waiting'],
    ['done', 'done'],
    ['failed', 'done'],
    ['cancelled', 'done'],
  ] as const)('maps %s to %s', (state, column) => {
    expect(boardColumnFor(state)).toBe(column);
  });

  it('covers every job state', () => {
    for (const state of JOB_STATES) {
      expect(['running', 'waiting', 'done']).toContain(boardColumnFor(state));
    }
  });
});

describe('costRollup', () => {
  it('sums task tokens into the job total', () => {
    const job: JobView = {
      id: 'j1',
      state: 'running',
      tasks: { a: task('a', 100), b: task('b', 250), c: task('c', 0) },
    };
    expect(costRollup(job)).toEqual({ jobTotal: 350, perTask: { a: 100, b: 250, c: 0 } });
  });

  it('returns zero for a job with no tasks', () => {
    expect(costRollup({ tasks: {} })).toEqual({ jobTotal: 0, perTask: {} });
  });
});
