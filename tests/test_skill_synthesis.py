import os
import subprocess
import tempfile
import pytest
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent

def test_synthesis_vitest_suite():
    """Verify Phase 5 skill synthesis via vitest."""
    cmd = ["npx", "vitest", "run", "src/agents/skills/synthesis/"]
    res = subprocess.run(cmd, cwd=str(REPO_ROOT), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert res.returncode == 0, f"Vitest skill synthesis failed:\nSTDOUT:\n{res.stdout}\nSTDERR:\n{res.stderr}"
    assert "passed" in res.stdout.lower()

def test_bwrap_network_isolation_escape_blocked():
    """Verify that network connections are unconditionally blocked inside the bwrap sandbox."""
    script = "import urllib.request; urllib.request.urlopen('https://example.com', timeout=2)"
    cmd = [
        "bwrap",
        "--unshare-net",
        "--ro-bind", "/", "/",
        "--tmpfs", "/tmp",
        "--proc", "/proc",
        "--dev", "/dev",
        "python3", "-c", script
    ]
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert res.returncode != 0, "Network connection should have failed inside sandbox!"
    assert "Temporary failure" in res.stderr or "URLError" in res.stderr or "Network is unreachable" in res.stderr

def test_bwrap_filesystem_write_escape_blocked():
    """Verify that filesystem write attempts outside scratch directory are strictly blocked."""
    script = "with open('/root/escape_attempt.txt', 'w') as f: f.write('escape')"
    cmd = [
        "bwrap",
        "--unshare-net",
        "--ro-bind", "/", "/",
        "--tmpfs", "/tmp",
        "--proc", "/proc",
        "--dev", "/dev",
        "python3", "-c", script
    ]
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert res.returncode != 0, "Host filesystem write outside scratch must be blocked!"
    assert "Read-only file system" in res.stderr or "Permission denied" in res.stderr

def test_three_seeded_missing_skills():
    """Run 3 seeded 'missing skill' scenarios through the synthesizer."""
    script = """
    import { synthesizeSkill } from './src/agents/skills/synthesis/synthesizer.ts';
    import { approvePromotion, listPendingPromotions } from './src/agents/skills/synthesis/promotion.ts';
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import os from 'node:os';

    async function run() {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'seeded-skills-'));

      // Seed 1: Palindrome Checker
      const s1 = await synthesizeSkill({
        name: 'palindrome_checker',
        description: 'Checks if a string is a palindrome',
        code: 'def is_palindrome(s: str) -> bool: cleaned = "".join(c.lower() for c in s if c.isalnum()); return cleaned == cleaned[::-1]',
        testCode: 'from solution import is_palindrome\\ndef test(): assert is_palindrome("A man, a plan, a canal: Panama"); assert not is_palindrome("hello")',
        language: 'python',
        createdAt: Date.now()
      }, { baseDir: tempDir });
      if (s1.status !== 'staged') throw new Error('Seed 1 failed');

      // Seed 2: Safe Integer Parser
      const s2 = await synthesizeSkill({
        name: 'safe_int_parser',
        description: 'Parses string to int with default fallback',
        code: 'def parse_int(v: str, default: int = 0) -> int: \\n    try: return int(v.strip())\\n    except: return default',
        testCode: 'from solution import parse_int\\ndef test(): assert parse_int("42") == 42; assert parse_int("abc", -1) == -1',
        language: 'python',
        createdAt: Date.now()
      }, { baseDir: tempDir });
      if (s2.status !== 'staged') throw new Error('Seed 2 failed');

      // Seed 3: Failing / Rejected skill
      const s3 = await synthesizeSkill({
        name: 'broken_calc',
        description: 'Broken calculator',
        code: 'def calc(): return 0',
        testCode: 'from solution import calc\\ndef test(): assert calc() == 100',
        language: 'python',
        createdAt: Date.now()
      }, { baseDir: tempDir });
      if (s3.status !== 'rejected') throw new Error('Seed 3 was not rejected');

      // Check human approval gate
      const pending = await listPendingPromotions(tempDir);
      if (pending.length !== 2) throw new Error(`Expected 2 pending promotions, got ${pending.length}`);

      await fs.rm(tempDir, { recursive: true, force: true });
      console.log('Seeded scenarios passed cleanly');
    }

    run().catch(e => { console.error(e); process.exit(1); });
    """
    cmd = ["npx", "tsx", "-e", script]
    res = subprocess.run(cmd, cwd=str(REPO_ROOT), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert res.returncode == 0, f"Seeded missing skills test failed:\n{res.stderr}\n{res.stdout}"

