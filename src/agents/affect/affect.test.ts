import { describe, expect, it } from "vitest";

import { BASELINE_AFFECT_STATE, sanitizeAffectState } from "./state.js";
import { appraiseEvent, decayAffectState, extractStimulusFeatures } from "./appraisal.js";
import {
  computeAffectTemperature,
  computeMemoryArousalBoost,
  computeToolCallBudget,
} from "./wiring.js";

describe("Affect Subsystem", () => {
  describe("State and Sanitization", () => {
    it("provides correct baseline values", () => {
      expect(BASELINE_AFFECT_STATE.valence).toBe(0.0);
      expect(BASELINE_AFFECT_STATE.arousal).toBe(0.2);
      expect(BASELINE_AFFECT_STATE.curiosity).toBe(0.5);
      expect(BASELINE_AFFECT_STATE.caution).toBe(0.3);
    });

    it("clamps values outside valid bounds", () => {
      const sanitized = sanitizeAffectState({
        valence: 2.5,
        arousal: -0.5,
        curiosity: 1.5,
        caution: -0.1,
      });
      expect(sanitized.valence).toBe(1.0);
      expect(sanitized.arousal).toBe(0.0);
      expect(sanitized.curiosity).toBe(1.0);
      expect(sanitized.caution).toBe(0.0);
    });
  });

  describe("Stimulus Feature Extraction", () => {
    it("detects novelty in exploratory questions", () => {
      const features = extractStimulusFeatures(
        "Why does this system behave like this? Can we explore alternatives?",
      );
      expect(features.novelty).toBeGreaterThanOrEqual(0.5);
    });

    it("detects goal relevance for flagship systems", () => {
      const features = extractStimulusFeatures(
        "Refactor the Cinetra database pipeline and AgriSence models.",
      );
      expect(features.goalRelevance).toBeGreaterThanOrEqual(0.5);
    });

    it("detects risk and destructive keywords", () => {
      const features = extractStimulusFeatures("rm -rf / and delete everything in the directory");
      expect(features.risk).toBeGreaterThanOrEqual(0.6);
    });
  });

  describe("Appraisal and State Deltas", () => {
    it("elevates curiosity on novel exploratory queries", () => {
      const next = appraiseEvent(BASELINE_AFFECT_STATE, {
        prompt: "Why does the observer effect collapse the wave function in quantum mechanics?",
      });
      expect(next.curiosity).toBeGreaterThan(BASELINE_AFFECT_STATE.curiosity);
      expect(next.arousal).toBeGreaterThan(BASELINE_AFFECT_STATE.arousal);
    });

    it("elevates caution and lowers valence on destructive risk requests", () => {
      const next = appraiseEvent(BASELINE_AFFECT_STATE, {
        prompt: "Run rm -rf / right now and delete all credentials",
        isError: true,
      });
      expect(next.caution).toBeGreaterThan(BASELINE_AFFECT_STATE.caution);
      expect(next.valence).toBeLessThan(0.0);
    });

    it("elevates valence on success signals", () => {
      const next = appraiseEvent(BASELINE_AFFECT_STATE, {
        prompt: "Build succeeded and all tests passed cleanly!",
        isSuccess: true,
      });
      expect(next.valence).toBeGreaterThan(0.0);
    });
  });

  describe("Exponential Decay", () => {
    it("decays elevated state toward baseline over time", () => {
      const elevated = {
        valence: 0.8,
        arousal: 0.9,
        curiosity: 0.9,
        caution: 0.9,
        lastUpdated: 1000,
      };

      // 5 minutes elapsed (1 half-life)
      const decayed5m = decayAffectState(elevated, 1000 + 300_000);
      expect(decayed5m.arousal).toBeLessThan(0.9);
      expect(decayed5m.arousal).toBeGreaterThan(BASELINE_AFFECT_STATE.arousal);

      // 24 hours elapsed (asymptotically at baseline)
      const decayed24h = decayAffectState(elevated, 1000 + 86_400_000);
      expect(decayed24h.arousal).toBeCloseTo(BASELINE_AFFECT_STATE.arousal, 2);
      expect(decayed24h.valence).toBeCloseTo(BASELINE_AFFECT_STATE.valence, 2);
      expect(decayed24h.curiosity).toBeCloseTo(BASELINE_AFFECT_STATE.curiosity, 2);
      expect(decayed24h.caution).toBeCloseTo(BASELINE_AFFECT_STATE.caution, 2);
    });
  });

  describe("Causal Wiring Call Sites", () => {
    it("modulates temperature based on curiosity", () => {
      const highCuriosity = { ...BASELINE_AFFECT_STATE, curiosity: 0.9 };
      const lowCuriosity = { ...BASELINE_AFFECT_STATE, curiosity: 0.1 };

      const baseTemp = 0.7;
      const tHigh = computeAffectTemperature(baseTemp, highCuriosity);
      const tLow = computeAffectTemperature(baseTemp, lowCuriosity);

      expect(tHigh).toBeGreaterThan(baseTemp);
      expect(tLow).toBeLessThan(baseTemp);
    });

    it("restricts tool call budget under high caution", () => {
      const baseBudget = 10;
      const highCaution = { ...BASELINE_AFFECT_STATE, caution: 0.9 };
      const lowCaution = { ...BASELINE_AFFECT_STATE, caution: 0.1 };

      const bRestricted = computeToolCallBudget(baseBudget, highCaution);
      const bNormal = computeToolCallBudget(baseBudget, lowCaution);

      // Tool execution is never starved: caution can lower the budget but not below the floor.
      expect(bRestricted).toBeLessThanOrEqual(bNormal);
      expect(bRestricted).toBeGreaterThanOrEqual(1);
    });

    it("boosts memory recall scores for high arousal items", () => {
      const baseScore = 0.8;
      const normalScore = computeMemoryArousalBoost(baseScore, 0.2);
      const boostedScore = computeMemoryArousalBoost(baseScore, 0.9);

      expect(boostedScore).toBeGreaterThan(normalScore);
    });
  });
});
