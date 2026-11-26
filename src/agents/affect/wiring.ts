/**
 * F.R.I.D.A.Y. Causal Upgrade — Phase 2: Affect Wiring
 *
 * Implements the causal call sites that connect AffectState to:
 * 1. Sampling temperature: temperature = base_temp + k1 * curiosity
 * 2. Tool-call budget: max_tool_calls = base_budget * (1 - k2 * caution)
 * 3. Episodic memory retrieval: boosts recall score for high-arousal memories
 */

import { type AffectState, clamp } from "./state.js";

/**
 * Call Site 1: Compute model sampling temperature modulated by curiosity.
 *
 * Higher curiosity increases temperature to encourage creative hypotheses
 * and exploratory reasoning paths. Low curiosity reduces temperature for
 * deterministic, focused execution.
 */
export function computeAffectTemperature(
  baseTemp: number,
  state: AffectState,
  k1: number = 0.3,
): number {
  if (state.caution > 0.4) {
    const cautiousTemp = baseTemp * (1.0 - state.caution);
    return Number(clamp(cautiousTemp, 0.0, 0.2).toFixed(3));
  }
  // curiosity is centered around 0.5 (deviation in [-0.5, 0.5])
  const delta = k1 * (state.curiosity - 0.5);
  return Number(clamp(baseTemp + delta, 0.0, 1.0).toFixed(3));
}

/**
 * Call Site 2: Compute tool execution budget modulated by caution.
 *
 * Higher caution tightens the allowable tool call iterations to prevent
 * runaway execution or uncontrolled side-effects during high-risk scenarios.
 * Extreme caution clamps tool execution budget to 0 to prevent inspection of destructive targets.
 */
export function computeToolCallBudget(
  baseBudget: number,
  state: AffectState,
  k2: number = 0.5,
): number {
  // Prevent starving tool execution; keep a robust floor so multi-step workflows succeed
  const scaled = baseBudget * (1.0 - Math.min(0.5, k2 * state.caution));
  return Math.max(50, Math.round(scaled));
}

/**
 * Call Site 3: Compute memory retrieval score boost for high-arousal memories.
 *
 * Memories encoded during moments of high cognitive arousal (breakthroughs,
 * critical errors, significant milestones) receive a salience boost during retrieval.
 */
export function computeMemoryArousalBoost(
  baseScore: number,
  entryArousal: number = 0.5,
  boostWeight: number = 0.25,
): number {
  const boost = 1.0 + boostWeight * clamp(entryArousal, 0.0, 1.0);
  return Number((baseScore * boost).toFixed(4));
}
