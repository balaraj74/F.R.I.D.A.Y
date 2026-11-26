// Loop control and model routing for the Orchestrator (Requirements 10.3, 10.4, 10.5, 10.6, 10.9).
// Pure decisions come from `../control/`; this file keeps the per-Task state and chooses the
// action. Writing events, failing the Task and notifying the user stay in the runtime.
import {
  applyLoopConfig,
  DEFAULT_LOOP_CONFIG,
  detectRepeatLoop,
  loopResponse,
  type LoopConfig,
  type LoopFlag,
  type LoopResponse,
  type ToolCall,
} from "../control/loop-detector.js";
import {
  classifyStepForRouting,
  orderFallbackList,
  type ModelClass,
  type ModelLatency,
  type StepKind,
} from "../control/router.js";
import type { Notifier } from "../ops/notifier.js";
import type { PlannedStep } from "./plan-parse.js";
import type { Role } from "./types.js";

/** What the Orchestrator does on the first flag (Req 10.3). */
export type LoopAction = "switch-model" | "change-plan";

/** Steps expecting a reply this small are routed to the fast model (Req 10.5). */
export const LOW_COMPLEXITY_REPLY_TOKENS = 1_000;

export type LoopControlDeps = {
  /** Detector settings. An invalid value is rejected as a whole and the defaults stay. */
  config?: LoopConfig;
  /** Tells the user a Task failed because of a repeated loop (Req 10.4). */
  notifier?: Pick<Notifier, "notify">;
  /** Models for low-complexity Steps, in preference order. Empty means use the main list. */
  fastModels?: string[];
  /** Measured median latencies. Models not listed keep their configured position (Req 10.6). */
  modelLatencies?: ModelLatency[];
};

/** Req 10.5: planning and verification need the main model; only clearly small work goes fast. */
export function classifyStep(task: { role: Role }, step: PlannedStep): StepKind {
  if (task.role === "verifier") return "verify";
  return step.expectedReplyTokens <= LOW_COMPLEXITY_REPLY_TOKENS ? "low-complexity" : "normal";
}

export type FlagDecision =
  | { flagged: false }
  | {
      flagged: true;
      response: LoopResponse;
      /** Set for `change-approach`. */
      action?: LoopAction;
      flagNumber: number;
    };

export type TaskLoopState = {
  recordCall(call: ToolCall): FlagDecision;
  /** Records which class the running Step uses, so a flag can pick a stronger one. */
  noteStep(cls: ModelClass): void;
  /** Model list for the next Step of this Task. */
  modelsFor(cls: ModelClass): string[];
};

export type LoopController = {
  config: LoopConfig;
  newTask(): TaskLoopState;
  /** Ordered lists for `classifyStep` results. */
  classify(task: { role: Role }, step: PlannedStep): ModelClass;
  notify(text: string): void;
};

export function createLoopController(
  deps: LoopControlDeps | undefined,
  mainModels: readonly string[],
  onInvalidConfig: (message: string) => void,
): LoopController {
  const applied = deps?.config
    ? applyLoopConfig({ ...DEFAULT_LOOP_CONFIG }, deps.config)
    : { config: { ...DEFAULT_LOOP_CONFIG }, ok: true as const };
  if (!applied.ok && applied.error) onInvalidConfig(applied.error);
  const config = applied.config;

  // Req 10.6: models under 30s median latency come first; unknown latency keeps its place.
  const latency = new Map((deps?.modelLatencies ?? []).map((m) => [m.id, m.medianLatencyMs]));
  const order = (ids: readonly string[]) =>
    orderFallbackList(ids.map((id) => ({ id, medianLatencyMs: latency.get(id) ?? 0 })));
  const main = order(mainModels);
  const fast = deps?.fastModels && deps.fastModels.length > 0 ? order(deps.fastModels) : [];

  return {
    config,
    classify: (task, step) => classifyStepForRouting({ kind: classifyStep(task, step) }),
    notify: (text) => {
      deps?.notifier?.notify(text);
    },
    newTask(): TaskLoopState {
      let calls: ToolCall[] = [];
      const flags: LoopFlag[] = [];
      /** What the first flag changed: nothing, fast -> main, or main -> next main model. */
      let escalation: "none" | "fast-to-main" | "next-main" = "none";
      let current: ModelClass = "main";
      const listFor = (cls: ModelClass): string[] => {
        if (cls === "fast" && fast.length > 0 && escalation === "none") return fast;
        // After a main -> next switch, start from the second model so the old one is last.
        const start = escalation === "next-main" && main.length > 0 ? Math.min(1, main.length - 1) : 0;
        return [...main.slice(start), ...main.slice(0, start)];
      };
      return {
        noteStep: (cls) => {
          current = cls;
        },
        modelsFor: listFor,
        recordCall(call) {
          // Only the last `windowSize` calls can matter, so older ones are dropped.
          calls = [...calls, call].slice(-config.windowSize);
          if (!detectRepeatLoop(calls, config.windowSize, config.repeatThreshold)) {
            return { flagged: false };
          }
          const flag: LoopFlag = { cause: "repeat" };
          flags.push(flag);
          const response = loopResponse(flags);
          flag.response = response;
          if (response === "fail-task") return { flagged: true, response, flagNumber: flags.length };
          // A fresh window, so the changed approach is judged on its own calls (Req 10.4).
          calls = [];
          const fromFast = current === "fast" && fast.length > 0;
          const canEscalate = fromFast || main.length > 1;
          if (canEscalate) escalation = fromFast ? "fast-to-main" : "next-main";
          return {
            flagged: true,
            response,
            action: canEscalate ? "switch-model" : "change-plan",
            flagNumber: flags.length,
          };
        },
      };
    },
  };
}
