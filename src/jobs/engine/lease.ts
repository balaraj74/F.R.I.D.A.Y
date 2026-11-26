import { err, ok, type Result } from "./types.js";

/** Lease duration and heartbeat extension (Req 5.7). */
export const LEASE_DURATION_MS = 30_000;

export interface Lease {
  stepId: string;
  expiresAtMs: number;
}

/** Grants a lease that expires `LEASE_DURATION_MS` after `now`. */
export function grantLease(now: number, stepId = ""): Lease {
  return { stepId, expiresAtMs: now + LEASE_DURATION_MS };
}

/**
 * Valid iff `now < lease.expiresAtMs`; the new expiry is `now + 30s`. A heartbeat at or
 * after expiry is rejected and the input lease is not modified (Req 5.7, 5.8).
 */
export function heartbeat(lease: Lease, now: number): Result<Lease, "expired"> {
  if (!(now < lease.expiresAtMs)) return err("expired");
  return ok({ stepId: lease.stepId, expiresAtMs: now + LEASE_DURATION_MS });
}
