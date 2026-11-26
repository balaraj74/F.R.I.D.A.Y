import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type {
  ConsolidatedFact,
  ConsolidationOptions,
  ConsolidationRunResult,
  MemoryContradiction,
} from "./types.js";
import { parseSessionLogs } from "./parser.js";
import { detectContradiction, persistContradictions } from "./contradiction.js";

function generateSimpleUnifiedDiff(
  filename: string,
  originalContent: string,
  newContent: string,
): string {
  if (originalContent === newContent) return "";

  const origLines = originalContent.split("\n");
  const newLines = newContent.split("\n");

  const header = `--- a/${filename}\n+++ b/${filename}\n@@ -1,${origLines.length} +1,${newLines.length} @@\n`;
  const diffBody: string[] = [];

  // Simple diff representation
  let i = 0;
  let j = 0;
  while (i < origLines.length || j < newLines.length) {
    if (i < origLines.length && j < newLines.length && origLines[i] === newLines[j]) {
      // unchanged
      i++;
      j++;
    } else if (j < newLines.length && (i >= origLines.length || !origLines.includes(newLines[j]))) {
      diffBody.push(`+ ${newLines[j]}`);
      j++;
    } else if (i < origLines.length && (j >= newLines.length || !newLines.includes(origLines[i]))) {
      diffBody.push(`- ${origLines[i]}`);
      i++;
    } else {
      diffBody.push(`- ${origLines[i]}`);
      diffBody.push(`+ ${newLines[j]}`);
      i++;
      j++;
    }
  }

  return (
    header +
    diffBody.slice(0, 50).join("\n") +
    (diffBody.length > 50 ? `\n... [${diffBody.length - 50} more lines]` : "") +
    "\n"
  );
}

export function insertFactIntoMarkdown(docText: string, fact: ConsolidatedFact): string {
  // Check if fact is already present in document
  if (docText.includes(fact.content)) {
    return docText;
  }

  const lines = docText.split("\n");
  const targetSection = fact.section;

  let sectionIndex = lines.findIndex(
    (l) => l.trim().toLowerCase() === targetSection.trim().toLowerCase(),
  );

  // If exact section heading not found, find by prefix
  if (sectionIndex === -1) {
    sectionIndex = lines.findIndex((l) =>
      l.trim().toLowerCase().startsWith(targetSection.trim().toLowerCase()),
    );
  }

  const formattedEntry = `- ${fact.content}`;

  if (sectionIndex !== -1) {
    // Insert under the section heading
    lines.splice(sectionIndex + 1, 0, formattedEntry);
    return lines.join("\n");
  }

  // Fallback: append section or append to end
  return `${docText.trim()}\n\n${targetSection}\n${formattedEntry}\n`;
}

export async function consolidateMemories(
  options: ConsolidationOptions = {},
): Promise<ConsolidationRunResult> {
  const workspaceDir = options.workspaceDir || process.cwd();
  const defaultSessionsDir = path.join(os.homedir(), ".friday", "agents", "main", "sessions");
  const sessionsDir = options.sessionsDir || defaultSessionsDir;
  const contradictionStorage = path.join(os.homedir(), ".friday", "memory_contradictions.json");

  const { facts, discardedCount, processedCount } = await parseSessionLogs({
    sessionsDir,
    hoursWindow: options.hoursWindow,
    salienceThreshold: options.salienceThreshold ?? 0.5,
  });

  const memoryFile = path.join(workspaceDir, "MEMORY.md");
  const userFile = path.join(workspaceDir, "USER.md");

  let memoryText = "";
  let userText = "";
  try {
    memoryText = await fs.readFile(memoryFile, "utf-8");
  } catch {
    memoryText = "# MEMORY.md\n";
  }

  try {
    userText = await fs.readFile(userFile, "utf-8");
  } catch {
    userText = "# USER.md\n";
  }

  const origMemoryText = memoryText;
  const origUserText = userText;

  const contradictionsFound: MemoryContradiction[] = [];
  const acceptedFacts: ConsolidatedFact[] = [];

  for (const fact of facts) {
    const docText = fact.targetFile === "MEMORY.md" ? memoryText : userText;
    const contradiction = detectContradiction(fact, docText);

    if (contradiction) {
      contradictionsFound.push(contradiction);
      // Do NOT overwrite or append contradicting fact
      continue;
    }

    acceptedFacts.push(fact);
    if (fact.targetFile === "MEMORY.md") {
      memoryText = insertFactIntoMarkdown(memoryText, fact);
    } else {
      userText = insertFactIntoMarkdown(userText, fact);
    }
  }

  // Persist contradictions for review
  if (contradictionsFound.length > 0) {
    await persistContradictions(contradictionsFound, contradictionStorage);
  }

  const updatedFiles: string[] = [];
  let unifiedDiff = "";

  const reviewMode = Boolean(options.proposalsDir) && !options.dryRun;
  const proposed: Array<{ name: "MEMORY.md" | "USER.md"; original: string; next: string }> = [];

  if (memoryText !== origMemoryText) {
    updatedFiles.push("MEMORY.md");
    unifiedDiff += generateSimpleUnifiedDiff("MEMORY.md", origMemoryText, memoryText);
    proposed.push({ name: "MEMORY.md", original: origMemoryText, next: memoryText });
    if (!options.dryRun && !reviewMode) {
      await fs.writeFile(memoryFile, memoryText, "utf-8");
    }
  }

  if (userText !== origUserText) {
    updatedFiles.push("USER.md");
    unifiedDiff += generateSimpleUnifiedDiff("USER.md", origUserText, userText);
    proposed.push({ name: "USER.md", original: origUserText, next: userText });
    if (!options.dryRun && !reviewMode) {
      await fs.writeFile(userFile, userText, "utf-8");
    }
  }

  let proposalDir: string | undefined;
  if (reviewMode && (proposed.length > 0 || contradictionsFound.length > 0)) {
    proposalDir = await writeProposal({
      proposalsDir: options.proposalsDir!,
      workspaceDir,
      proposed,
      unifiedDiff,
      contradictions: contradictionsFound,
    });
  }

  return {
    processedSessions: processedCount,
    extractedFacts: acceptedFacts.length,
    discardedLowSalience: discardedCount,
    contradictionsFound,
    updatedFiles,
    unifiedDiff,
    ...(proposalDir ? { proposalDir } : {}),
  };
}

type ProposalManifest = {
  createdAt: number;
  workspaceDir: string;
  /** sha256 of each file when the proposal was made; apply refuses if they changed since. */
  base: Record<string, string>;
  files: string[];
};

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

async function writeProposal(params: {
  proposalsDir: string;
  workspaceDir: string;
  proposed: Array<{ name: string; original: string; next: string }>;
  unifiedDiff: string;
  contradictions: MemoryContradiction[];
}): Promise<string> {
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(params.proposalsDir, day);
  await fs.mkdir(dir, { recursive: true });
  const manifest: ProposalManifest = {
    createdAt: Date.now(),
    workspaceDir: params.workspaceDir,
    base: Object.fromEntries(params.proposed.map((p) => [p.name, sha256(p.original)])),
    files: params.proposed.map((p) => p.name),
  };
  for (const p of params.proposed) await fs.writeFile(path.join(dir, p.name), p.next, "utf-8");
  await fs.writeFile(path.join(dir, "proposal.json"), JSON.stringify(manifest, null, 2), "utf-8");
  const review = [
    `# Memory consolidation proposal (${day})`,
    "",
    params.proposed.length > 0
      ? `Proposed changes to: ${params.proposed.map((p) => p.name).join(", ")}. Apply with \`friday memory consolidate --apply ${day}\`.`
      : "No file changes proposed.",
    "",
    params.contradictions.length > 0 ? "## Contradictions (not applied, need your call)" : "",
    ...params.contradictions.map(
      (c) =>
        `- ${c.targetFile} › ${c.section}: existing "${c.existingFact}" vs new "${c.newFact}" (${c.conflictReason})`,
    ),
    "",
    "## Diff",
    "```diff",
    params.unifiedDiff.trimEnd(),
    "```",
    "",
  ].join("\n");
  await fs.writeFile(path.join(dir, "REVIEW.md"), review, "utf-8");
  return dir;
}

/** Apply a reviewed proposal. Refuses if the target files changed after it was made. */
export async function applyConsolidationProposal(
  proposalDir: string,
): Promise<{ applied: string[] }> {
  const manifest = JSON.parse(
    await fs.readFile(path.join(proposalDir, "proposal.json"), "utf-8"),
  ) as ProposalManifest;
  const targets = manifest.files.map((name) => ({
    name,
    target: path.join(manifest.workspaceDir, name),
    next: path.join(proposalDir, name),
  }));
  for (const t of targets) {
    const current = await fs.readFile(t.target, "utf-8").catch(() => "");
    if (sha256(current) !== manifest.base[t.name]) {
      throw new Error(
        `${t.name} changed since this proposal was made; re-run consolidation instead of applying a stale proposal.`,
      );
    }
  }
  for (const t of targets) await fs.copyFile(t.next, t.target);
  await fs.writeFile(path.join(proposalDir, "APPLIED"), new Date().toISOString(), "utf-8");
  return { applied: targets.map((t) => t.name) };
}
