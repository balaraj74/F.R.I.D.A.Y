import type { RunnerClock } from "../runner/deps.js";

export type TimeoutResult<T> = { timedOut: false; value: T } | { timedOut: true };

/**
 * Runs `work` and gives up after `ms` on the injected clock. The signal passed to `work`
 * aborts on timeout (and when `parent` aborts) so the work can stop. A rejection of `work`
 * propagates; a late result after a timeout is ignored.
 */
export function withTimeout<T>(
  clock: RunnerClock,
  ms: number,
  work: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
): Promise<TimeoutResult<T>> {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener("abort", onParentAbort, { once: true });

  return new Promise<TimeoutResult<T>>((resolve, reject) => {
    const cancel = clock.setTimer(() => {
      controller.abort(new Error(`timed out after ${ms}ms`));
      resolve({ timedOut: true });
    }, ms);
    const cleanup = () => {
      cancel();
      parent?.removeEventListener("abort", onParentAbort);
    };
    let promise: Promise<T>;
    try {
      promise = work(controller.signal);
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    promise.then(
      (value) => {
        cleanup();
        resolve({ timedOut: false, value });
      },
      (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
