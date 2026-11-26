// In-process control flags for one running Job: pause gate, cancel signal and a wake-up for the
// scheduler. The authoritative Job state is still the Event_Log; this only decides when the
// Orchestrator may start the next Step (Requirements 8.10-8.12).

export class JobControl {
  private pausedFlag = false;
  private cancelledFlag = false;
  private readonly cancelController = new AbortController();
  private pauseWaiters: Array<() => void> = [];
  private changeSignal = deferred();

  get paused(): boolean {
    return this.pausedFlag;
  }

  get cancelled(): boolean {
    return this.cancelledFlag;
  }

  /** Aborts when the Job is cancelled. Running Steps stop through it. */
  get signal(): AbortSignal {
    return this.cancelController.signal;
  }

  /** From now on no Step starts until `resume` or `cancel`. Running Steps are not interrupted. */
  pause(): void {
    if (this.cancelledFlag) return;
    this.pausedFlag = true;
    this.notify();
  }

  resume(): void {
    this.pausedFlag = false;
    this.releasePauseWaiters();
    this.notify();
  }

  cancel(): void {
    if (this.cancelledFlag) return;
    this.cancelledFlag = true;
    this.pausedFlag = false;
    this.cancelController.abort(new Error("job cancelled"));
    this.releasePauseWaiters();
    this.notify();
  }

  /** Resolves at once unless the Job is paused; then on resume or cancel. */
  waitWhilePaused(): Promise<void> {
    if (!this.pausedFlag) return Promise.resolve();
    return new Promise<void>((resolve) => this.pauseWaiters.push(resolve));
  }

  /** Resolves at the next pause, resume, cancel or `notify()`. Share-safe: callers get one promise. */
  changed(): Promise<void> {
    return this.changeSignal.promise;
  }

  /** Wakes the scheduler, e.g. when a Task enters or leaves waiting_approval. */
  notify(): void {
    const previous = this.changeSignal;
    this.changeSignal = deferred();
    previous.resolve();
  }

  private releasePauseWaiters(): void {
    const waiters = this.pauseWaiters;
    this.pauseWaiters = [];
    for (const wake of waiters) wake();
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

export const ABORTED = Symbol("aborted");

/** Resolves with the work's result, or `ABORTED` as soon as the signal aborts. The work is abandoned. */
export function raceAbort<T>(signal: AbortSignal, work: Promise<T>): Promise<T | typeof ABORTED> {
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.resolve(ABORTED);
  }
  return new Promise<T | typeof ABORTED>((resolve, reject) => {
    const onAbort = () => {
      work.catch(() => undefined);
      resolve(ABORTED);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
