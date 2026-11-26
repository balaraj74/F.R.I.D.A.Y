import os
import json
import tempfile
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent

def test_memory_consolidation_subsystem():
    """Verify Phase 4 memory consolidation via vitest."""
    cmd = ["npx", "vitest", "run", "src/agents/memory/consolidation/"]
    res = subprocess.run(cmd, cwd=str(REPO_ROOT), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert res.returncode == 0, f"Vitest memory consolidation failed:\nSTDOUT:\n{res.stdout}\nSTDERR:\n{res.stderr}"
    assert "passed" in res.stdout.lower()

def test_deliberate_contradiction_detection():
    """Verify that a deliberate contradiction in sessions is flagged and not silently resolved."""
    script = """
    import { detectContradiction } from './src/agents/memory/consolidation/contradiction.ts';
    const existing = "Location: Bengaluru, Karnataka, India\\n- prefers dark theme";
    const fact = {
      id: "test",
      category: "user_preference",
      targetFile: "USER.md",
      section: "## User Preferences",
      content: "I switched to light theme permanently",
      sourceSessionId: "s1",
      timestamp: Date.now(),
      salience: 0.9
    };
    const conflict = detectContradiction(fact, existing);
    if (!conflict || !conflict.conflictReason.includes("contradiction")) {
      process.exit(1);
    }
    process.exit(0);
    """
    cmd = ["npx", "tsx", "-e", script]
    res = subprocess.run(cmd, cwd=str(REPO_ROOT), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert res.returncode == 0, f"Contradiction test failed:\nSTDOUT:\n{res.stdout}\nSTDERR:\n{res.stderr}"

