// progress.md (the Progress_File) rendering. Pure: the runner does the file I/O.

/** Longest note kept per Step, so progress.md stays small across a long Job. */
export const PROGRESS_NOTE_MAX_CHARS = 500;

export type ProgressEntry = {
  stepId: string;
  taskId?: string;
  atMs: number;
  /** Short summary of what the Step did. Truncated to `PROGRESS_NOTE_MAX_CHARS`. */
  note: string;
};

function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

/** Appends one section for the completed Step to the previous Progress_File text. */
export function renderProgress(previous: string, entry: ProgressEntry): string {
  const head =
    previous.trim().length > 0 ? `${previous.replace(/\s+$/, "")}\n\n` : "# Progress\n\n";
  const where =
    entry.taskId === undefined ? entry.stepId : `${entry.stepId} (task ${entry.taskId})`;
  const when = new Date(entry.atMs).toISOString();
  return `${head}## Step ${where} completed ${when}\n${truncate(entry.note, PROGRESS_NOTE_MAX_CHARS)}\n`;
}
