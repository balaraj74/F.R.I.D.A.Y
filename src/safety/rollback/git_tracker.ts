import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SelfModificationRecord, SelfModificationType } from "./types.js";

const execFileAsync = promisify(execFile);

export async function commitSelfModification(params: {
  repoRoot: string;
  type: SelfModificationType;
  description: string;
  files: string[];
  baselinePassRate?: number;
  baseDir?: string;
}): Promise<SelfModificationRecord> {
  const baseDir = params.baseDir || path.join(os.homedir(), ".friday");
  const recordsFile = path.join(baseDir, "self_modifications.json");

  // Git add
  await execFileAsync("git", ["add", ...params.files], { cwd: params.repoRoot });

  const commitMsg = `self-mod: [${params.type}] ${params.description}`;
  await execFileAsync("git", ["commit", "-m", commitMsg], { cwd: params.repoRoot });

  // Get commit hash
  const { stdout: hashOut } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: params.repoRoot,
  });
  const commitHash = hashOut.trim();

  // Create tag
  const timestamp = Date.now();
  const tag = `self-mod-${timestamp}-${params.type}`;
  await execFileAsync("git", ["tag", tag], { cwd: params.repoRoot });

  const record: SelfModificationRecord = {
    id: tag,
    type: params.type,
    description: params.description,
    commitHash,
    tag,
    timestamp,
    baselinePassRate: params.baselinePassRate ?? 96.7,
    reverted: false,
  };

  await fs.mkdir(path.dirname(recordsFile), { recursive: true });
  let existing: SelfModificationRecord[] = [];
  try {
    const raw = await fs.readFile(recordsFile, "utf-8");
    existing = JSON.parse(raw);
  } catch {
    existing = [];
  }
  existing.push(record);
  await fs.writeFile(recordsFile, JSON.stringify(existing, null, 2), "utf-8");

  return record;
}

export async function revertSelfModification(params: {
  repoRoot: string;
  record: SelfModificationRecord;
  reason: string;
  baseDir?: string;
}): Promise<{ success: boolean; revertHash?: string; error?: string }> {
  const baseDir = params.baseDir || path.join(os.homedir(), ".friday");
  const alertsLog = path.join(baseDir, "logs", "safety_alerts.log");

  try {
    await execFileAsync("git", ["revert", "HEAD", "--no-edit"], { cwd: params.repoRoot });
    const { stdout: revOut } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: params.repoRoot,
    });
    const revertHash = revOut.trim();

    params.record.reverted = true;
    params.record.revertCommitHash = revertHash;

    const alertMessage = `[SAFETY CRITICAL] Auto-reverted self-modification ${params.record.id} (${params.record.commitHash}): ${params.reason}\nRevert commit: ${revertHash}\nTimestamp: ${new Date().toISOString()}\n`;
    await fs.mkdir(path.dirname(alertsLog), { recursive: true });
    await fs.appendFile(alertsLog, alertMessage, "utf-8");

    // Update records file
    const recordsFile = path.join(baseDir, "self_modifications.json");
    try {
      const raw = await fs.readFile(recordsFile, "utf-8");
      const records: SelfModificationRecord[] = JSON.parse(raw);
      const match = records.find((r) => r.id === params.record.id);
      if (match) {
        match.reverted = true;
        match.revertCommitHash = revertHash;
        await fs.writeFile(recordsFile, JSON.stringify(records, null, 2), "utf-8");
      }
    } catch {}

    return { success: true, revertHash };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}
