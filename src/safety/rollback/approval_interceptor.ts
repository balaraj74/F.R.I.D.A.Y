import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { SelfModApprovalRequest, SelfModificationType } from "./types.js";

export async function requestSelfModApproval(params: {
  type: SelfModificationType;
  description: string;
  diff: string;
  baseDir?: string;
}): Promise<SelfModApprovalRequest> {
  const baseDir = params.baseDir || path.join(os.homedir(), ".friday");
  const pendingFile = path.join(baseDir, "pending_self_mods.json");

  const req: SelfModApprovalRequest = {
    id: crypto.randomUUID(),
    type: params.type,
    description: params.description,
    diff: params.diff,
    requestedAt: Date.now(),
    status: "pending",
  };

  await fs.mkdir(path.dirname(pendingFile), { recursive: true });

  let existing: SelfModApprovalRequest[] = [];
  try {
    const raw = await fs.readFile(pendingFile, "utf-8");
    existing = JSON.parse(raw);
  } catch {
    existing = [];
  }

  existing.push(req);
  await fs.writeFile(pendingFile, JSON.stringify(existing, null, 2), "utf-8");
  return req;
}

export async function listPendingSelfMods(baseDir?: string): Promise<SelfModApprovalRequest[]> {
  const dir = baseDir || path.join(os.homedir(), ".friday");
  const pendingFile = path.join(dir, "pending_self_mods.json");
  try {
    const raw = await fs.readFile(pendingFile, "utf-8");
    const items: SelfModApprovalRequest[] = JSON.parse(raw);
    return items.filter((i) => i.status === "pending");
  } catch {
    return [];
  }
}

export async function approveSelfMod(
  id: string,
  baseDir?: string,
): Promise<{ success: boolean; error?: string }> {
  const dir = baseDir || path.join(os.homedir(), ".friday");
  const pendingFile = path.join(dir, "pending_self_mods.json");
  let items: SelfModApprovalRequest[] = [];
  try {
    const raw = await fs.readFile(pendingFile, "utf-8");
    items = JSON.parse(raw);
  } catch {
    return { success: false, error: "Pending file not found" };
  }

  const match = items.find((i) => i.id === id);
  if (!match) return { success: false, error: "Request not found" };

  match.status = "approved";
  match.decidedAt = Date.now();
  await fs.writeFile(pendingFile, JSON.stringify(items, null, 2), "utf-8");
  return { success: true };
}

export async function rejectSelfMod(
  id: string,
  baseDir?: string,
): Promise<{ success: boolean; error?: string }> {
  const dir = baseDir || path.join(os.homedir(), ".friday");
  const pendingFile = path.join(dir, "pending_self_mods.json");
  let items: SelfModApprovalRequest[] = [];
  try {
    const raw = await fs.readFile(pendingFile, "utf-8");
    items = JSON.parse(raw);
  } catch {
    return { success: false, error: "Pending file not found" };
  }

  const match = items.find((i) => i.id === id);
  if (!match) return { success: false, error: "Request not found" };

  match.status = "rejected";
  match.decidedAt = Date.now();
  await fs.writeFile(pendingFile, JSON.stringify(items, null, 2), "utf-8");
  return { success: true };
}
