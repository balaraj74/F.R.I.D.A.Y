// Errors that must not take FRIDAY down: the terminal she was started from went away (writes
// to stdout/stderr fail with EIO/EPIPE), or Node closed a forgotten file handle during garbage
// collection after it was already closed (EBADF). Neither affects her state; crashing on them
// knocked the gateway (and WhatsApp, reminders, the HUD) offline.

export function isBenignProcessError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; message?: unknown; syscall?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  const message = typeof e.message === "string" ? e.message : "";
  if ((code === "EIO" || code === "EPIPE") && (e.syscall === "write" || /\bwrite\b/.test(message)))
    return true;
  if (code === "EBADF" && /on garbage collection/i.test(message)) return true;
  return false;
}

/** Report without risking another failed write to a dead terminal. */
export function noteBenignProcessError(error: unknown): void {
  try {
    process.stderr.write(
      `[friday] ignored harmless error: ${String((error as Error)?.message ?? error)}\n`,
    );
  } catch {
    // the terminal is gone; nothing to tell
  }
}
