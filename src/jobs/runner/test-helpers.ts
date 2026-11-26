// Fakes for Step_Runner and Watchdog tests: a manual clock, an in-memory file system and an
// event recorder. Excluded from the build by tsconfig (`test-helpers.ts`).
import type { RunnerClock, RunnerFs } from "./deps.js";
import type { AppendedEvent, NewEvent } from "../store/types.js";

type Timer = { id: number; at: number; fn: () => void };

/** Lets queued promise callbacks run without moving the fake time. */
export async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

export class FakeClock implements RunnerClock {
  private current: number;
  private timers: Timer[] = [];
  private nextId = 1;

  constructor(startMs = 1_000_000) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  setTimer(fn: () => void, ms: number): () => void {
    const id = this.nextId++;
    this.timers.push({ id, at: this.current + Math.max(ms, 0), fn });
    return () => {
      this.timers = this.timers.filter((t) => t.id !== id);
    };
  }

  /** Moves time forward without firing timers, e.g. to model a paused process. */
  jump(ms: number): void {
    this.current += ms;
  }

  /** Advances time, firing due timers in order and letting promise chains run after each. */
  async advance(ms: number): Promise<void> {
    const target = this.current + ms;
    for (;;) {
      const due = this.timers
        .filter((t) => t.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.current = Math.max(this.current, due.at);
      due.fn();
      await flushMicrotasks();
    }
    this.current = Math.max(this.current, target);
    await flushMicrotasks();
  }

  /** Runs until `promise` settles by repeatedly jumping to the next timer. */
  async drive<T>(promise: Promise<T>, maxMs = 24 * 3_600_000): Promise<T> {
    let settled = false;
    const tracked = promise.finally(() => {
      settled = true;
    });
    tracked.catch(() => undefined);
    const limit = this.current + maxMs;
    await flushMicrotasks();
    while (!settled) {
      const next = this.timers.reduce<number | null>(
        (min, t) => (min === null || t.at < min ? t.at : min),
        null,
      );
      if (next === null || next > limit) throw new Error("drive: promise never settled");
      await this.advance(Math.max(next - this.current, 0));
    }
    return promise;
  }
}

export class MemoryFs implements RunnerFs {
  files = new Map<string, string>();
  writes: string[] = [];
  /** When set, `writeText` rejects with this error. */
  failWrites?: Error;
  /** When true, `writeText` never settles. */
  hangWrites = false;

  async readText(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async writeText(path: string, text: string): Promise<void> {
    if (this.hangWrites) return new Promise<void>(() => undefined);
    if (this.failWrites) throw this.failWrites;
    this.writes.push(path);
    this.files.set(path, text);
  }
}

/** Collects events with the same shape the Event_Log returns. */
export class EventRecorder {
  events: AppendedEvent[] = [];
  /** Event types for which `append` throws, to simulate Event_Log write failures. */
  failOn = new Set<string>();

  append = (e: NewEvent): AppendedEvent => {
    if (this.failOn.has(e.type)) throw new Error(`append failed: ${e.type}`);
    const appended: AppendedEvent = {
      id: this.events.length + 1,
      jobId: e.jobId,
      ...(e.taskId !== undefined ? { taskId: e.taskId } : {}),
      ...(e.stepId !== undefined ? { stepId: e.stepId } : {}),
      type: e.type,
      payload: JSON.parse(JSON.stringify(e.payload ?? null)) as unknown,
      createdAtMs: e.createdAtMs ?? Date.now(),
    };
    this.events.push(appended);
    return appended;
  };

  types(): string[] {
    return this.events.map((e) => e.type);
  }

  ofType(type: string): AppendedEvent[] {
    return this.events.filter((e) => e.type === type);
  }
}
