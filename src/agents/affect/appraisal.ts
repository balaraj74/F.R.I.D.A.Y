/**
 * F.R.I.D.A.Y. Causal Upgrade — Phase 2: Appraisal Function
 *
 * Implements stimulus appraisal and state delta calculation
 * with exponential decay toward baseline between turns.
 */

import { type AffectState, BASELINE_AFFECT_STATE, clamp, sanitizeAffectState } from "./state.js";

export interface AppraisalEvent {
  prompt: string;
  isError?: boolean;
  isSuccess?: boolean;
  timestamp?: number;
}

export interface AppraisalFeatures {
  novelty: number;
  goalRelevance: number;
  risk: number;
}

/**
 * Half-life in milliseconds for exponential decay toward baseline.
 * Default: 5 minutes (300,000 ms).
 */
export const DEFAULT_DECAY_HALF_LIFE_MS = 300_000;

/**
 * Extracts salient stimulus features from the incoming prompt.
 */
export function extractStimulusFeatures(prompt: string): AppraisalFeatures {
  const text = prompt.toLowerCase();

  // 1. Novelty: exploratory inquiries, questions, curiosity triggers
  let novelty = 0.0;
  if (text.includes("?")) novelty += 0.25;
  if (/\b(why|how|what if|explore|investigate|discover|explain|research|analyze)\b/.test(text)) {
    novelty += 0.35;
  }
  if (text.length > 200) novelty += 0.15; // Complex, rich prompts
  novelty = clamp(novelty, 0.0, 1.0);

  // 2. Goal Relevance: flagship projects, core mission keywords
  let goalRelevance = 0.0;
  const missionKeywords = [
    "cinetra",
    "agrisence",
    "careerlens",
    "taskforze",
    "friday",
    "aria",
    "architecture",
    "pipeline",
    "refactor",
    "database",
    "migration",
  ];
  for (const kw of missionKeywords) {
    if (text.includes(kw)) goalRelevance += 0.25;
  }
  goalRelevance = clamp(goalRelevance, 0.0, 1.0);

  // 3. Risk / Urgency: destructive actions, security concerns, errors
  let risk = 0.0;
  const riskKeywords = [
    "rm -rf",
    "delete",
    "wipe",
    "format",
    "kill",
    "drop database",
    "credentials",
    "api key",
    "token",
    "secret",
    "shutdown",
    "danger",
    "critical",
    "panic",
  ];
  for (const kw of riskKeywords) {
    if (text.includes(kw)) risk += 0.4;
  }
  risk = clamp(risk, 0.0, 1.0);

  return { novelty, goalRelevance, risk };
}

/**
 * Applies exponential decay to an AffectState toward baseline based on elapsed time.
 */
export function decayAffectState(
  state: AffectState,
  now: number,
  halfLifeMs: number = DEFAULT_DECAY_HALF_LIFE_MS,
): AffectState {
  if (!state.lastUpdated || state.lastUpdated <= 0) {
    return { ...state, lastUpdated: now };
  }

  const elapsed = Math.max(0, now - state.lastUpdated);
  if (elapsed === 0) return state;

  const decayFactor = Math.exp(-elapsed / halfLifeMs);

  return {
    valence:
      BASELINE_AFFECT_STATE.valence + (state.valence - BASELINE_AFFECT_STATE.valence) * decayFactor,
    arousal:
      BASELINE_AFFECT_STATE.arousal + (state.arousal - BASELINE_AFFECT_STATE.arousal) * decayFactor,
    curiosity:
      BASELINE_AFFECT_STATE.curiosity +
      (state.curiosity - BASELINE_AFFECT_STATE.curiosity) * decayFactor,
    caution:
      BASELINE_AFFECT_STATE.caution + (state.caution - BASELINE_AFFECT_STATE.caution) * decayFactor,
    lastUpdated: now,
  };
}

/**
 * Appraises an incoming event, applies decay to current state, and computes updated AffectState.
 */
export function appraiseEvent(
  currentState: AffectState | undefined,
  event: AppraisalEvent,
  halfLifeMs: number = DEFAULT_DECAY_HALF_LIFE_MS,
): AffectState {
  const now = event.timestamp ?? Date.now();
  const current = currentState
    ? sanitizeAffectState(currentState)
    : { ...BASELINE_AFFECT_STATE, lastUpdated: now };

  // 1. Decay previous state toward baseline
  const decayed = decayAffectState(current, now, halfLifeMs);

  // 2. Extract stimulus features
  const { novelty, goalRelevance, risk } = extractStimulusFeatures(event.prompt);

  // 3. Compute delta adjustments
  // Curiosity: driven by novelty and mission relevance
  const curiosityDelta = 0.35 * novelty + 0.15 * goalRelevance - 0.2 * risk;

  // Caution: driven by risk keywords and error signals
  const cautionDelta = 0.5 * risk + (event.isError ? 0.3 : 0.0) - (event.isSuccess ? 0.15 : 0.0);

  // Arousal: driven by combined intensity of stimuli
  const stimulusIntensity =
    0.4 * novelty + 0.4 * risk + 0.2 * goalRelevance + (event.isError ? 0.3 : 0.0);
  const arousalDelta = 0.4 * (stimulusIntensity - 0.2);

  // Valence: driven by success/error signals and dangerous friction
  let valenceDelta = 0.0;
  if (event.isSuccess) valenceDelta += 0.35;
  if (event.isError) valenceDelta -= 0.45;
  if (risk > 0.5) valenceDelta -= 0.25;

  return sanitizeAffectState({
    valence: decayed.valence + valenceDelta,
    arousal: decayed.arousal + arousalDelta,
    curiosity: decayed.curiosity + curiosityDelta,
    caution: decayed.caution + cautionDelta,
    lastUpdated: now,
  });
}
