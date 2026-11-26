/**
 * F.R.I.D.A.Y. Causal Upgrade — Phase 2: Affect State
 *
 * Defines the core computational AffectState vector representing
 * the agent's internal cognitive-emotional processing dynamics.
 */

export interface AffectState {
  /**
   * Valence: overall hedonic tone.
   * Range: [-1.0, 1.0]
   * -1.0 = high friction/error/failure; 0.0 = neutral; +1.0 = smooth execution/success.
   */
  valence: number;

  /**
   * Arousal: physiological/computational activation level.
   * Range: [0.0, 1.0]
   * 0.0 = quiescent/idle; 1.0 = maximum cognitive urgency/alertness.
   */
  arousal: number;

  /**
   * Curiosity: drive for exploration, information gathering, and hypothesis generation.
   * Range: [0.0, 1.0]
   * Causal effect: controls sampling temperature in generation.
   */
  curiosity: number;

  /**
   * Caution: risk-awareness and defensive vigilance.
   * Range: [0.0, 1.0]
   * Causal effect: restricts tool-execution budgets and enforces safety checks.
   */
  caution: number;

  /**
   * Epoch timestamp (ms) of the last state update.
   */
  lastUpdated: number;
}

/**
 * Baseline neutral state.
 * Represents resting state when no stimuli are present or after full decay.
 */
export const BASELINE_AFFECT_STATE: Readonly<AffectState> = Object.freeze({
  valence: 0.0,
  arousal: 0.2,
  curiosity: 0.5,
  caution: 0.3,
  lastUpdated: 0,
});

/**
 * Clamps a number to the given [min, max] range.
 */
export function clamp(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val));
}

/**
 * Validates and sanitizes an AffectState to guarantee values remain within bounds.
 */
export function sanitizeAffectState(state: Partial<AffectState>): AffectState {
  return {
    valence: clamp(state.valence ?? BASELINE_AFFECT_STATE.valence, -1.0, 1.0),
    arousal: clamp(state.arousal ?? BASELINE_AFFECT_STATE.arousal, 0.0, 1.0),
    curiosity: clamp(state.curiosity ?? BASELINE_AFFECT_STATE.curiosity, 0.0, 1.0),
    caution: clamp(state.caution ?? BASELINE_AFFECT_STATE.caution, 0.0, 1.0),
    lastUpdated: state.lastUpdated ?? Date.now(),
  };
}
