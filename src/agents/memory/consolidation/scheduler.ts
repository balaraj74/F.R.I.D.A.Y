import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { consolidateMemories } from "./consolidator.js";
import type { ConsolidationOptions, ConsolidationRunResult } from "./types.js";

const log = createSubsystemLogger("memory-consolidation");

let isConsolidating = false;

export async function runMemoryConsolidationJob(
  options: ConsolidationOptions = {},
): Promise<ConsolidationRunResult> {
  if (isConsolidating) {
    log.info("Memory consolidation already in progress, skipping duplicate trigger.");
    return {
      processedSessions: 0,
      extractedFacts: 0,
      discardedLowSalience: 0,
      contradictionsFound: [],
      updatedFiles: [],
      unifiedDiff: "",
    };
  }

  isConsolidating = true;
  try {
    log.info("Starting memory consolidation job...", { dryRun: options.dryRun });
    const result = await consolidateMemories(options);
    log.info("Memory consolidation job finished", {
      processed: result.processedSessions,
      facts: result.extractedFacts,
      discarded: result.discardedLowSalience,
      contradictions: result.contradictionsFound.length,
      updatedFiles: result.updatedFiles,
    });
    return result;
  } catch (err) {
    log.error("Memory consolidation job failed", { error: String(err) });
    throw err;
  } finally {
    isConsolidating = false;
  }
}

/** Milliseconds until the next local HH:MM. */
export function msUntilNextLocalTime(hour: number, minute: number, now = new Date()): number {
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

/**
 * Nightly consolidation in review mode: proposals land in `proposalsDir/<date>/REVIEW.md`
 * and nothing in MEMORY.md/USER.md changes until Sir applies one
 * (`friday memory consolidate --apply <date>`). Returns a stop function.
 */
export function startMemoryConsolidationSchedule(params: {
  workspaceDir: string;
  sessionsDir: string;
  proposalsDir: string;
  hour?: number;
  minute?: number;
}): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(
      async () => {
        try {
          const result = await runMemoryConsolidationJob({
            workspaceDir: params.workspaceDir,
            sessionsDir: params.sessionsDir,
            proposalsDir: params.proposalsDir,
            hoursWindow: 24,
          });
          if (result.proposalDir)
            log.info(`Memory consolidation proposal ready: ${result.proposalDir}`);
        } catch {
          // already logged by runMemoryConsolidationJob; try again tomorrow
        }
        schedule();
      },
      msUntilNextLocalTime(params.hour ?? 3, params.minute ?? 30),
    );
    timer.unref?.();
  };
  schedule();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
