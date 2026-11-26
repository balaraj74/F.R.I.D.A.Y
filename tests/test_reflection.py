import os
import subprocess
import tempfile
import pytest
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent

def test_reflection_vitest_suite():
    """Verify Phase 6 reflection subsystem via vitest."""
    cmd = ["npx", "vitest", "run", "src/agents/reflection/"]
    res = subprocess.run(cmd, cwd=str(REPO_ROOT), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert res.returncode == 0, f"Vitest reflection failed:\nSTDOUT:\n{res.stdout}\nSTDERR:\n{res.stderr}"
    assert "passed" in res.stdout.lower()

def test_self_model_remains_bounded():
    """Simulate 30 days of high-volume task turns and verify self_model size stays strictly bounded."""
    script = """
    import { recordLesson, loadLessons } from './src/agents/reflection/self_model.ts';
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import os from 'node:os';

    async function run() {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bounded-test-'));
      // Simulate 120 turns across 30 days
      for (let i = 1; i <= 120; i++) {
        await recordLesson({
          id: `sim-day-${i}`,
          query: `Simulated task for day ${Math.ceil(i / 4)}`,
          lesson: `Lesson from task ${i}: always verify pre-conditions.`,
          outcome: 'success',
          timestamp: Date.now() + i * 1000
        }, tempDir, { maxEntries: 50, compactionThreshold: 60 });
      }

      const lessons = await loadLessons(tempDir);
      if (lessons.length > 50) {
        throw new Error(`Self-model capacity breached: ${lessons.length} > 50`);
      }

      const fileStat = await fs.stat(path.join(tempDir, 'self_model.jsonl'));
      // Bounded file size should be well under 100KB
      if (fileStat.size > 100 * 1024) {
        throw new Error(`Self-model file size unconstrained: ${fileStat.size} bytes`);
      }

      await fs.rm(tempDir, { recursive: true, force: true });
      console.log('Self-model bounded size verified: count=' + lessons.length + ', size=' + fileStat.size);
    }
    run().catch(e => { console.error(e); process.exit(1); });
    """
    cmd = ["npx", "tsx", "-e", script]
    res = subprocess.run(cmd, cwd=str(REPO_ROOT), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert res.returncode == 0, f"Self-model bounded test failed:\n{res.stderr}\n{res.stdout}"

