import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { PromotionRequest } from "./types.js";

export async function listPendingPromotions(baseDir?: string): Promise<PromotionRequest[]> {
  const dir = baseDir || path.join(os.homedir(), ".friday");
  const pendingFile = path.join(dir, "pending_promotions.json");
  try {
    const raw = await fs.readFile(pendingFile, "utf-8");
    const items: PromotionRequest[] = JSON.parse(raw);
    return items.filter((item) => item.status === "pending");
  } catch {
    return [];
  }
}

export async function approvePromotion(
  requestId: string,
  baseDir?: string,
): Promise<{ success: boolean; targetPath?: string; error?: string }> {
  const dir = baseDir || path.join(os.homedir(), ".friday");
  const pendingFile = path.join(dir, "pending_promotions.json");
  let items: PromotionRequest[] = [];
  try {
    const raw = await fs.readFile(pendingFile, "utf-8");
    items = JSON.parse(raw);
  } catch {
    return { success: false, error: "Pending promotions file not found" };
  }

  const req = items.find((item) => item.id === requestId);
  if (!req) {
    return { success: false, error: `Promotion request ${requestId} not found` };
  }
  if (req.status !== "pending") {
    return { success: false, error: `Promotion request is already ${req.status}` };
  }

  const stagedSkillDir = path.join(dir, "staged_skills", req.skill.name);
  const liveSkillDir = path.join(dir, "skills", req.skill.name);

  try {
    await fs.mkdir(path.dirname(liveSkillDir), { recursive: true });
    await fs.cp(stagedSkillDir, liveSkillDir, { recursive: true });
    req.status = "approved";
    req.decidedAt = Date.now();
    await fs.writeFile(pendingFile, JSON.stringify(items, null, 2), "utf-8");
    return { success: true, targetPath: liveSkillDir };
  } catch (err) {
    return { success: false, error: `Failed to promote skill: ${String(err)}` };
  }
}

export async function rejectPromotion(
  requestId: string,
  reason: string,
  baseDir?: string,
): Promise<{ success: boolean; error?: string }> {
  const dir = baseDir || path.join(os.homedir(), ".friday");
  const pendingFile = path.join(dir, "pending_promotions.json");
  let items: PromotionRequest[] = [];
  try {
    const raw = await fs.readFile(pendingFile, "utf-8");
    items = JSON.parse(raw);
  } catch {
    return { success: false, error: "Pending promotions file not found" };
  }

  const req = items.find((item) => item.id === requestId);
  if (!req) {
    return { success: false, error: `Promotion request ${requestId} not found` };
  }

  req.status = "rejected";
  req.decidedAt = Date.now();
  await fs.writeFile(pendingFile, JSON.stringify(items, null, 2), "utf-8");

  // Clean up staged skill
  const stagedSkillDir = path.join(dir, "staged_skills", req.skill.name);
  try {
    await fs.rm(stagedSkillDir, { recursive: true, force: true });
  } catch {}

  return { success: true };
}
