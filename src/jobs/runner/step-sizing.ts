// Planner step sizing (Requirement 6.5): no Step's expected reply may exceed the Proxy output cap.

/** Proxy output cap in tokens. */
export const MAX_STEP_REPLY_TOKENS = 64_000;

function normalize(estimate: number): number {
  if (typeof estimate !== "number" || Number.isNaN(estimate)) {
    throw new RangeError("expected reply size must be a number of tokens");
  }
  if (estimate === Number.POSITIVE_INFINITY || estimate === Number.NEGATIVE_INFINITY) {
    throw new RangeError("expected reply size must be finite");
  }
  return Math.max(Math.ceil(estimate), 0);
}

/** True when an expected reply of `estimate` tokens fits under the Proxy cap. */
export function fitsProxyCap(estimate: number): boolean {
  return normalize(estimate) <= MAX_STEP_REPLY_TOKENS;
}

/** Clamp an estimate to the cap. Negative values become 0, fractions round up. */
export function capStepReplyTokens(estimate: number): number {
  return Math.min(normalize(estimate), MAX_STEP_REPLY_TOKENS);
}

/**
 * Split work whose expected reply is `estimate` tokens into the fewest Steps that each stay at
 * or under the cap. The parts are as even as possible, are integers, and sum to the rounded-up
 * estimate. An estimate of 0 (or less) yields one empty Step so the Task still has a Step.
 * Throws RangeError for NaN or infinite input.
 */
export function splitStepEstimate(estimate: number): number[] {
  const total = normalize(estimate);
  const count = Math.max(Math.ceil(total / MAX_STEP_REPLY_TOKENS), 1);
  const base = Math.floor(total / count);
  const remainder = total - base * count;
  // The first `remainder` parts take one extra token; the largest part is ceil(total / count).
  return Array.from({ length: count }, (_, i) => base + (i < remainder ? 1 : 0));
}
