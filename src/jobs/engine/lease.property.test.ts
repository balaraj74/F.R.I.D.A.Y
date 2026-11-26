import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { grantLease, heartbeat, LEASE_DURATION_MS, type Lease } from "./lease.js";

// Feature: friday-design-orchestrator-harness, Property 18: Lease grant and heartbeat semantics
// **Validates: Requirements 5.7, 5.8**

const LEASE_MS = 30_000;

/** Millisecond timestamps in a range where `now + 30000` stays exact in a double. */
const timeArb = fc.integer({ min: 0, max: 1_000_000_000_000 });

/** Heartbeat times as offsets from the grant time, so most runs mix valid and expired beats. */
const offsetsArb = fc.array(fc.integer({ min: -5_000, max: 90_000 }), { maxLength: 30 });

describe("Feature: friday-design-orchestrator-harness, Property 18: Lease grant and heartbeat semantics", () => {
  it("grants a lease that expires exactly 30000 ms after the grant time", () => {
    expect(LEASE_DURATION_MS).toBe(LEASE_MS);
    fc.assert(
      fc.property(timeArb, fc.string(), (now, stepId) => {
        expect(grantLease(now, stepId)).toEqual({ stepId, expiresAtMs: now + LEASE_MS });
      }),
      { numRuns: 200 },
    );
  });

  it("extends the expiry to heartbeatTime + 30000 for any heartbeat strictly before expiry", () => {
    fc.assert(
      fc.property(
        timeArb,
        fc.integer({ min: 1, max: LEASE_MS }),
        fc.string(),
        (grantTime, gap, stepId) => {
          const lease = Object.freeze(grantLease(grantTime, stepId));
          // gap in [1, 30000] puts the heartbeat at expiry - gap, strictly before expiry.
          const beat = lease.expiresAtMs - gap;
          const result = heartbeat(lease, beat);
          expect(result).toEqual({ ok: true, value: { stepId, expiresAtMs: beat + LEASE_MS } });
        },
      ),
      { numRuns: 200 },
    );
  });

  it("rejects any heartbeat at or after expiry as expired and leaves the lease unchanged", () => {
    fc.assert(
      fc.property(
        timeArb,
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.string(),
        (grantTime, overshoot, stepId) => {
          const lease = Object.freeze(grantLease(grantTime, stepId));
          const snapshot: Lease = { ...lease };
          // overshoot 0 is the exact-expiry boundary, which must be rejected.
          const result = heartbeat(lease, lease.expiresAtMs + overshoot);
          expect(result).toEqual({ ok: false, error: "expired" });
          expect(lease).toEqual(snapshot);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("matches the strict-before-expiry model across any sequence of heartbeat times", () => {
    fc.assert(
      fc.property(timeArb, offsetsArb, (grantTime, offsets) => {
        let lease: Lease = grantLease(grantTime, "step");
        for (const offset of offsets) {
          const beat = grantTime + offset;
          const before: Lease = { ...lease };
          const frozen = Object.freeze({ ...lease });
          const result = heartbeat(frozen, beat);
          // The input lease is never mutated, whichever way the heartbeat goes.
          expect(frozen).toEqual(before);
          if (beat < before.expiresAtMs) {
            expect(result).toEqual({
              ok: true,
              value: { stepId: before.stepId, expiresAtMs: beat + LEASE_MS },
            });
            if (result.ok) lease = result.value;
          } else {
            expect(result).toEqual({ ok: false, error: "expired" });
            // Rejected heartbeat: the lease keeps its current expiry.
            expect(lease).toEqual(before);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it("treats the exact expiry instant as expired and one millisecond earlier as valid", () => {
    const lease = grantLease(1_000, "s");
    expect(heartbeat(lease, 31_000)).toEqual({ ok: false, error: "expired" });
    expect(heartbeat(lease, 30_999)).toEqual({
      ok: true,
      value: { stepId: "s", expiresAtMs: 60_999 },
    });
  });
});
