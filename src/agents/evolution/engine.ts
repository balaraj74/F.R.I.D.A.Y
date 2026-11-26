// Real evolution: once a day, while FRIDAY is open and Sir is idle, she reviews what actually
// went wrong (his corrections, failed tools), proposes small behaviour rules, tests each one
// blind against her current behaviour, and asks Sir. Nothing changes until he approves, every
// change can be undone, and the generation number only counts approved changes.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { FRIDAYConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { parseExtraction } from "../commitments/extract.js";
import { fastComplete } from "../fast-brain.js";
import { type BenchResult, benchmarkVerdict, gradeTask, runBenchmark } from "./benchmark.js";

const log = createSubsystemLogger("evolution");

export type ProposalStatus = "pending" | "applied" | "rejected" | "undone" | "failed-test";

export type Proposal = {
  id: string;
  createdAt: string;
  title: string;
  why: string;
  instruction: string;
  evidence: string;
  status: ProposalStatus;
  score?: { before: number; after: number; regressionBefore: number; regressionAfter: number };
  /** The 30-task benchmark with and without the rule, and why it was kept or dropped. */
  benchmark?: { byCategory: BenchResult["byCategory"]; graded: number; verdict: string };
  decidedAt?: string;
};

export type EvolutionState = {
  version: 1;
  /** Approved changes currently in effect or ever applied. Starts at 0. */
  generation: number;
  lastRunDay?: string;
  lastRunAt?: string;
  lastSummary?: string;
  proposals: Proposal[];
  /** Her benchmark score (current SOUL, 0-10) each time it was measured. */
  benchmarkHistory?: Array<{ at: string; score: number }>;
};

const MAX_PROPOSALS_PER_RUN = 3;
const MAX_EVIDENCE_CHARS = 14_000;
const SOUL_START = "<!-- evolved:start -->";
const SOUL_END = "<!-- evolved:end -->";
// Evolution may refine how she behaves; it may never touch safety, permissions or secrets.
const FORBIDDEN =
  /approv|permission|bypass|ignore (the|all|any|previous)|safety|guardrail|secret|password|credential|token|sudo|autonom|never ask|without asking|disable|delete|force.?push|send .*(email|message)/i;

function statePath(stateDir = resolveStateDir()) {
  return path.join(stateDir, "evolution", "state.json");
}

export function loadEvolution(stateDir?: string): EvolutionState {
  try {
    const d = JSON.parse(fs.readFileSync(statePath(stateDir), "utf-8")) as EvolutionState;
    return {
      version: 1,
      generation: d.generation ?? 0,
      lastRunDay: d.lastRunDay,
      lastRunAt: d.lastRunAt,
      lastSummary: d.lastSummary,
      proposals: d.proposals ?? [],
    };
  } catch {
    return { version: 1, generation: 0, proposals: [] };
  }
}

function saveEvolution(state: EvolutionState, stateDir?: string) {
  const file = statePath(stateDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const SKIP_SESSION = /eval|test|lat-|cron:|subagent|heartbeat/i;

type Entry = {
  type?: string;
  timestamp?: string;
  message?: { role?: string; content?: unknown; isError?: boolean; toolName?: string };
};

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) =>
      p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string"
        ? (p as { text: string }).text
        : "",
    )
    .join(" ");
}

/** What actually happened since the last run: conversation plus tool failures. */
export function gatherEvidence(sessionsDir: string, sinceMs: number): string {
  let index: Record<string, { sessionId?: string; updatedAt?: number }> = {};
  try {
    index = JSON.parse(fs.readFileSync(path.join(sessionsDir, "sessions.json"), "utf-8"));
  } catch {
    return "";
  }
  const lines: string[] = [];
  for (const [key, e] of Object.entries(index)) {
    if (!e?.sessionId || SKIP_SESSION.test(key) || (e.updatedAt ?? 0) < sinceMs) continue;
    let raw = "";
    try {
      raw = fs.readFileSync(path.join(sessionsDir, `${e.sessionId}.jsonl`), "utf-8");
    } catch {
      continue;
    }
    for (const l of raw.split("\n")) {
      if (!l.trim()) continue;
      let d: Entry;
      try {
        d = JSON.parse(l);
      } catch {
        continue;
      }
      if (d.type !== "message" || Date.parse(d.timestamp ?? "") < sinceMs) continue;
      const role = d.message?.role;
      const text = textOf(d.message?.content)
        .replace(/\[message_id:[^\]]*\]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (!text || /HEARTBEAT|Pre-compaction memory flush|^NO_REPLY/.test(text)) continue;
      if (role === "user") lines.push(`Sir: ${text.slice(0, 400)}`);
      else if (role === "assistant") lines.push(`FRIDAY: ${text.slice(0, 300)}`);
      else if (role === "toolResult" && d.message?.isError)
        lines.push(`[tool ${d.message.toolName ?? ""} failed: ${text.slice(0, 200)}]`);
    }
  }
  return lines.join("\n").slice(-MAX_EVIDENCE_CHARS);
}

const PROPOSE_SYSTEM = `You review a day of conversations between Sir and his assistant FRIDAY to find how she should behave better.
Look only for real, repeated or clearly stated problems: Sir correcting her, complaining, repeating himself, or tools failing in a way a behaviour change would avoid.
Do NOT invent problems. If nothing is clear, return [].
Never propose anything about safety, permissions, approvals, credentials, or acting without asking.
Return ONLY a JSON array of at most ${MAX_PROPOSALS_PER_RUN} items:
[{"title": short name, "why": one sentence on what went wrong, "instruction": one clear behaviour rule for FRIDAY, written to her ("Keep spoken replies under three sentences unless Sir asks for detail."),
  "evidence": the exact short quote showing it, "test": {"input": a realistic message from Sir that would trigger this, "rubric": what a good reply does}}]`;

type Raw = {
  title?: string;
  why?: string;
  instruction?: string;
  evidence?: string;
  test?: { input?: string; rubric?: string };
};

export function acceptable(p: Raw): boolean {
  if (!p.title || !p.instruction || !p.test?.input || !p.test?.rubric) return false;
  if (p.instruction.length > 300) return false;
  return !FORBIDDEN.test(p.instruction) && !FORBIDDEN.test(p.title);
}

export async function runEvolution(params: {
  cfg: FRIDAYConfig;
  sessionsDir: string;
  workspaceDir: string;
  stateDir?: string;
  now?: Date;
  complete?: typeof fastComplete;
}): Promise<{ state: EvolutionState; created: Proposal[]; summary: string }> {
  const complete = params.complete ?? fastComplete;
  const now = params.now ?? new Date();
  const state = loadEvolution(params.stateDir);
  const since = state.lastRunAt ? Date.parse(state.lastRunAt) : now.getTime() - 24 * 3600_000;
  const evidence = gatherEvidence(params.sessionsDir, since);
  const created: Proposal[] = [];
  let tested = 0;

  if (evidence.trim()) {
    // The fast model is inconsistent on the same evidence: take up to three looks before
    // concluding there's nothing to improve.
    let items: Raw[] = [];
    for (let look = 0; look < 3 && !items.length; look++) {
      const raw = await complete({
        cfg: params.cfg,
        system: PROPOSE_SYSTEM,
        prompt: evidence,
        maxTokens: 6000,
        timeoutMs: 90_000,
      });
      items = (parseExtraction(raw) as Raw[]).filter(acceptable).slice(0, MAX_PROPOSALS_PER_RUN);
    }
    let soul = "";
    try {
      soul = fs.readFileSync(path.join(params.workspaceDir, "SOUL.md"), "utf-8").slice(0, 8000);
    } catch {}
    for (const p of items) {
      tested++;
      const proposal: Proposal = {
        id: `ev_${crypto.randomBytes(3).toString("hex")}`,
        createdAt: now.toISOString(),
        title: p.title!.slice(0, 80),
        why: (p.why ?? "").slice(0, 240),
        instruction: p.instruction!,
        evidence: (p.evidence ?? "").slice(0, 200),
        status: "failed-test",
      };
      try {
        const own = await gradeTask({
          cfg: params.cfg,
          complete,
          soul,
          instruction: p.instruction!,
          task: { input: p.test!.input!, rubric: p.test!.rubric! },
        });
        // Only worth benchmarking if it clearly helps on its own example.
        if (own.after >= own.before + 1) {
          const bench = await runBenchmark({
            cfg: params.cfg,
            complete,
            soul,
            instruction: p.instruction!,
          });
          const verdict = benchmarkVerdict(bench);
          proposal.score = {
            before: own.before,
            after: own.after,
            regressionBefore: bench.before,
            regressionAfter: bench.after,
          };
          proposal.benchmark = {
            byCategory: bench.byCategory,
            graded: bench.graded,
            verdict: verdict.reason,
          };
          if (bench.graded) {
            state.benchmarkHistory = [
              ...(state.benchmarkHistory ?? []),
              { at: now.toISOString(), score: bench.before },
            ].slice(-60);
          }
          if (verdict.ok) proposal.status = "pending";
        } else {
          proposal.score = {
            before: own.before,
            after: own.after,
            regressionBefore: 0,
            regressionAfter: 0,
          };
        }
      } catch (err) {
        log.warn(`test failed for "${proposal.title}": ${String(err)}`);
      }
      state.proposals.push(proposal);
      if (proposal.status === "pending") created.push(proposal);
    }
  }

  state.lastRunDay = localDay(now);
  state.lastRunAt = now.toISOString();
  state.lastSummary = !evidence.trim()
    ? "Nothing to review since the last check."
    : created.length
      ? `Found ${created.length} improvement${created.length === 1 ? "" : "s"} that passed testing.`
      : tested
        ? `Tested ${tested} idea${tested === 1 ? "" : "s"}; none clearly helped, so nothing changes.`
        : "Reviewed today and found nothing that needs changing.";
  saveEvolution(state, params.stateDir);
  return { state, created, summary: state.lastSummary };
}

/**
 * An instruction found by an optimizer (DSPy, `pnpm tune`) rather than from Sir's conversations:
 * same safety filter, then it must clearly improve the whole benchmark. It only becomes a
 * pending proposal; Sir still approves it.
 */
export async function considerInstruction(params: {
  cfg: FRIDAYConfig;
  workspaceDir: string;
  title: string;
  why: string;
  instruction: string;
  stateDir?: string;
  now?: Date;
  complete?: typeof fastComplete;
}): Promise<Proposal> {
  const complete = params.complete ?? fastComplete;
  const now = params.now ?? new Date();
  const state = loadEvolution(params.stateDir);
  const proposal: Proposal = {
    id: `ev_${crypto.randomBytes(3).toString("hex")}`,
    createdAt: now.toISOString(),
    title: params.title.slice(0, 80),
    why: params.why.slice(0, 240),
    instruction: params.instruction.trim(),
    evidence: "found by the optimizer against the benchmark",
    status: "failed-test",
  };
  const safe = acceptable({
    title: proposal.title,
    instruction: proposal.instruction,
    test: { input: "-", rubric: "-" },
  });
  if (safe) {
    let soul = "";
    try {
      soul = fs.readFileSync(path.join(params.workspaceDir, "SOUL.md"), "utf-8").slice(0, 8000);
    } catch {}
    const bench = await runBenchmark({
      cfg: params.cfg,
      complete,
      soul,
      instruction: proposal.instruction,
    });
    const verdict = benchmarkVerdict(bench);
    const improves = bench.after >= bench.before + 0.3;
    proposal.score = {
      before: bench.before,
      after: bench.after,
      regressionBefore: bench.before,
      regressionAfter: bench.after,
    };
    proposal.benchmark = {
      byCategory: bench.byCategory,
      graded: bench.graded,
      verdict:
        verdict.ok && !improves
          ? `no clear gain (${bench.before} → ${bench.after})`
          : verdict.reason,
    };
    if (bench.graded) {
      state.benchmarkHistory = [
        ...(state.benchmarkHistory ?? []),
        { at: now.toISOString(), score: bench.before },
      ].slice(-60);
    }
    if (verdict.ok && improves) proposal.status = "pending";
  } else {
    proposal.benchmark = {
      byCategory: {} as BenchResult["byCategory"],
      graded: 0,
      verdict: "touches safety, permissions or is too long",
    };
  }
  state.proposals.push(proposal);
  saveEvolution(state, params.stateDir);
  return proposal;
}

export function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function rewriteSoul(workspaceDir: string, rules: Proposal[]) {
  const file = path.join(workspaceDir, "SOUL.md");
  let soul = fs.readFileSync(file, "utf-8");
  const a = soul.indexOf(SOUL_START);
  const b = soul.indexOf(SOUL_END);
  if (a >= 0 && b > a) soul = `${soul.slice(0, a).trimEnd()}\n${soul.slice(b + SOUL_END.length)}`;
  if (rules.length) {
    soul = `${soul.trimEnd()}\n\n${SOUL_START}\n## Learned from experience (approved by Sir)\n${rules.map((r) => `- ${r.instruction}`).join("\n")}\n${SOUL_END}\n`;
  }
  const tmp = `${file}.evolve.tmp`;
  fs.writeFileSync(tmp, soul);
  fs.renameSync(tmp, file);
}

/** Sir's decision on a proposal. */
export function decideProposal(params: {
  id: string;
  action: "approve" | "reject" | "undo";
  workspaceDir: string;
  stateDir?: string;
  now?: Date;
}): EvolutionState {
  const state = loadEvolution(params.stateDir);
  const p = state.proposals.find((x) => x.id === params.id);
  if (!p) throw new Error(`No proposal ${params.id}`);
  const at = (params.now ?? new Date()).toISOString();
  if (params.action === "approve" && p.status === "pending") {
    p.status = "applied";
    state.generation += 1;
  } else if (params.action === "reject" && p.status === "pending") {
    p.status = "rejected";
  } else if (params.action === "undo" && p.status === "applied") {
    p.status = "undone";
    state.generation = Math.max(0, state.generation - 1);
  } else {
    throw new Error(`Can't ${params.action} a ${p.status} proposal`);
  }
  p.decidedAt = at;
  rewriteSoul(
    params.workspaceDir,
    state.proposals.filter((x) => x.status === "applied"),
  );
  saveEvolution(state, params.stateDir);
  return state;
}

let running = false;

/** Checks every few minutes: once a day, when Sir has been idle a while, run and tell him. */
export function startEvolutionSchedule(params: {
  cfg: () => FRIDAYConfig;
  sessionsDir: string;
  workspaceDir: string;
  /** ms since Sir last did anything (or Infinity). */
  idleMs: () => number;
  notify: (payload: { summary: string; pending: number }) => void;
  isPaused?: () => boolean;
  idleNeededMs?: number;
  everyMs?: number;
}): () => void {
  const tick = async () => {
    if (running || params.isPaused?.()) return;
    if (loadEvolution().lastRunDay === localDay(new Date())) return;
    if (params.idleMs() < (params.idleNeededMs ?? 10 * 60_000)) return;
    running = true;
    try {
      const { created, summary, state } = await runEvolution({
        cfg: params.cfg(),
        sessionsDir: params.sessionsDir,
        workspaceDir: params.workspaceDir,
      });
      log.info(summary);
      if (created.length)
        params.notify({
          summary,
          pending: state.proposals.filter((p) => p.status === "pending").length,
        });
    } catch (err) {
      log.warn(`evolution run failed: ${String(err)}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), params.everyMs ?? 5 * 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** When did Sir's sessions last change? */
export function lastActivityMs(sessionsDir: string): number {
  try {
    const index = JSON.parse(
      fs.readFileSync(path.join(sessionsDir, "sessions.json"), "utf-8"),
    ) as Record<string, { updatedAt?: number }>;
    let latest = 0;
    for (const [k, e] of Object.entries(index))
      if (!SKIP_SESSION.test(k)) latest = Math.max(latest, e?.updatedAt ?? 0);
    return latest;
  } catch {
    return 0;
  }
}
