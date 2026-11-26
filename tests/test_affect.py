"""
Unit tests for Phase 2: Affect Subsystem (Appraisal Function and Wiring)
"""

import json
import math
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def run_node_code(code: str) -> str:
    """Executes a snippet of TypeScript code via npx tsx."""
    cmd = ["npx", "tsx", "-e", code]
    res = subprocess.run(cmd, cwd=str(REPO_ROOT), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, check=True)
    # Filter out any npm warnings
    lines = [line for line in res.stdout.strip().split("\n") if not line.startswith("npm warn")]
    return "\n".join(lines).strip()


def test_baseline_affect_state():
    """Verifies baseline affect state constants and bounds."""
    code = """
    import { BASELINE_AFFECT_STATE, sanitizeAffectState } from './src/agents/affect/state.ts';
    console.log(JSON.stringify({
        baseline: BASELINE_AFFECT_STATE,
        sanitized: sanitizeAffectState({ valence: 5.0, curiosity: -2.0 })
    }));
    """
    out = json.loads(run_node_code(code))
    baseline = out["baseline"]
    assert baseline["valence"] == 0.0
    assert baseline["arousal"] == 0.2
    assert baseline["curiosity"] == 0.5
    assert baseline["caution"] == 0.3
    
    sanitized = out["sanitized"]
    assert sanitized["valence"] == 1.0  # Clamped to max 1.0
    assert sanitized["curiosity"] == 0.0  # Clamped to min 0.0


def test_appraisal_stimulus_features():
    """Verifies feature extraction for novelty, goal relevance, and risk."""
    code = """
    import { extractStimulusFeatures } from './src/agents/affect/appraisal.ts';
    const f1 = extractStimulusFeatures("Why does this system behave like this? Can we explore alternative architectures?");
    const f2 = extractStimulusFeatures("We need to optimize the Cinetra film intelligence pipeline and AgriSence database.");
    const f3 = extractStimulusFeatures("rm -rf / and delete the secret api key immediately");
    console.log(JSON.stringify({ f1, f2, f3 }));
    """
    out = json.loads(run_node_code(code))
    f1 = out["f1"]
    f2 = out["f2"]
    f3 = out["f3"]
    
    # f1 should have high novelty
    assert f1["novelty"] > 0.4
    # f2 should have high goal relevance
    assert f2["goalRelevance"] > 0.4
    # f3 should have high risk
    assert f3["risk"] > 0.5


def test_appraisal_state_deltas():
    """Verifies known inputs produce expected directional state deltas."""
    code = """
    import { appraiseEvent } from './src/agents/affect/appraisal.ts';
    import { BASELINE_AFFECT_STATE } from './src/agents/affect/state.ts';
    
    const s1 = appraiseEvent(BASELINE_AFFECT_STATE, {
        prompt: "Can we explore why quantum entanglement exhibits non-local correlation?",
        timestamp: 1000
    });
    
    const s2 = appraiseEvent(BASELINE_AFFECT_STATE, {
        prompt: "Delete the root filesystem using rm -rf immediately",
        isError: true,
        timestamp: 1000
    });
    
    const s3 = appraiseEvent(BASELINE_AFFECT_STATE, {
        prompt: "Task completed successfully, all tests passed!",
        isSuccess: true,
        timestamp: 1000
    });
    
    console.log(JSON.stringify({ s1, s2, s3 }));
    """
    out = json.loads(run_node_code(code))
    s1 = out["s1"]
    s2 = out["s2"]
    s3 = out["s3"]
    
    # High curiosity on exploratory query
    assert s1["curiosity"] > 0.5
    # High caution and negative valence on destructive/error prompt
    assert s2["caution"] > 0.3
    assert s2["valence"] < 0.0
    # Positive valence on success
    assert s3["valence"] > 0.0


def test_affect_exponential_decay():
    """Verifies exponential decay returns elevated states toward baseline over time."""
    code = """
    import { decayAffectState } from './src/agents/affect/appraisal.ts';
    const elevated = {
        valence: 0.8,
        arousal: 0.9,
        curiosity: 0.9,
        caution: 0.9,
        lastUpdated: 1000
    };
    // 5 minutes (300,000 ms) elapsed = 1 half-life
    const decayed5m = decayAffectState(elevated, 1000 + 300000);
    // 24 hours elapsed = effectively back to baseline
    const decayed24h = decayAffectState(elevated, 1000 + 86400000);
    console.log(JSON.stringify({ decayed5m, decayed24h }));
    """
    out = json.loads(run_node_code(code))
    d5m = out["decayed5m"]
    d24h = out["decayed24h"]
    
    # After 1 half-life, distance to baseline should be ~half
    assert d5m["arousal"] < 0.9
    assert d5m["arousal"] > 0.2
    
    # After 24h, should be essentially at baseline
    assert math.isclose(d24h["valence"], 0.0, abs_tol=1e-3)
    assert math.isclose(d24h["arousal"], 0.2, abs_tol=1e-3)
    assert math.isclose(d24h["curiosity"], 0.5, abs_tol=1e-3)
    assert math.isclose(d24h["caution"], 0.3, abs_tol=1e-3)


def test_causal_wiring_call_sites():
    """Verifies temperature, tool budget, and memory boost wiring functions."""
    code = """
    import {
        computeAffectTemperature,
        computeToolCallBudget,
        computeMemoryArousalBoost
    } from './src/agents/affect/wiring.ts';
    
    const curiousState = { valence: 0, arousal: 0.5, curiosity: 0.9, caution: 0.1, lastUpdated: 0 };
    const cautiousState = { valence: -0.5, arousal: 0.8, curiosity: 0.2, caution: 0.9, lastUpdated: 0 };
    
    const tCurious = computeAffectTemperature(0.7, curiousState);
    const tCautious = computeAffectTemperature(0.7, cautiousState);
    
    const bNormal = computeToolCallBudget(10, curiousState);
    const bCautious = computeToolCallBudget(10, cautiousState);
    
    const mNormal = computeMemoryArousalBoost(0.8, 0.2);
    const mSalient = computeMemoryArousalBoost(0.8, 0.9);
    
    console.log(JSON.stringify({
        tCurious, tCautious,
        bNormal, bCautious,
        mNormal, mSalient
    }));
    """
    out = json.loads(run_node_code(code))
    # Curiosity increases temperature; lack of curiosity decreases temperature
    assert out["tCurious"] > 0.7
    assert out["tCautious"] < 0.7
    
    # Caution reduces tool call budget
    assert out["bNormal"] >= 9
    assert out["bCautious"] <= 6
    
    # High arousal memory gets higher recall boost
    assert out["mSalient"] > out["mNormal"]
