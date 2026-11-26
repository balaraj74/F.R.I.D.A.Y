type SessionHeaderEntry = { type: "session"; id?: string; cwd?: string };

/**
 * Give a brand-new session file FRIDAY's session id and workspace cwd.
 *
 * pi 0.49 never persisted the first user message into a pre-created file without an assistant
 * reply, so FRIDAY used to truncate such files and mark the manager unflushed. pi 1.x appends to
 * existing files directly and creates new ones exclusively (`wx`), so that reset is gone: it
 * made the first write fail with EEXIST. Orphaned trailing user messages are repaired by the
 * runner instead (see run/attempt.ts).
 */
export async function prepareSessionManagerForRun(params: {
  sessionManager: unknown;
  sessionFile: string;
  hadSessionFile: boolean;
  sessionId: string;
  cwd: string;
}): Promise<void> {
  const sm = params.sessionManager as {
    sessionId: string;
    fileEntries: Array<SessionHeaderEntry | { type: string }>;
  };

  const header = sm.fileEntries.find((e): e is SessionHeaderEntry => e.type === "session");

  if (!params.hadSessionFile && header) {
    header.id = params.sessionId;
    header.cwd = params.cwd;
    sm.sessionId = params.sessionId;
    return;
  }
}
