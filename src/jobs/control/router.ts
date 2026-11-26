/**
 * Pure Router logic (Requirements 10.5, 10.6).
 * No I/O: the Step_Runner passes in the Step kind and measured model latencies.
 */

export type StepKind = "plan" | "verify" | "low-complexity" | "normal";

export type ModelClass = "main" | "fast";

export type ModelLatency = { id: string; medianLatencyMs: number };

/** Models with a median latency at or above this value go after all faster models (Req 10.6). */
export const SLOW_MODEL_LATENCY_MS = 30_000;

/**
 * Picks the model class for a Step (Req 10.5). Planning and verification Steps go to the main
 * model, low-complexity Steps go to the fast model. Req 10.5 does not cover "normal" Steps;
 * they use the main model so only explicitly low-complexity work is sent to the weaker model.
 */
export function classifyStepForRouting(step: { kind: StepKind }): ModelClass {
  return step.kind === "low-complexity" ? "fast" : "main";
}

/**
 * Orders the fallback list so every model with median latency below 30s comes before every
 * model at or above 30s (Req 10.6). Relative order is preserved inside each group.
 * A latency that is not a number (NaN) fails the `<` test and is treated as slow.
 */
export function orderFallbackList(models: ReadonlyArray<ModelLatency>): string[] {
  const fast: string[] = [];
  const slow: string[] = [];
  for (const model of models) {
    (model.medianLatencyMs < SLOW_MODEL_LATENCY_MS ? fast : slow).push(model.id);
  }
  return [...fast, ...slow];
}
