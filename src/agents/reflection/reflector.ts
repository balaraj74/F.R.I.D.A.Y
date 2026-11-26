import type { CritiqueParams } from "./types.js";

export function critiqueAttempt(params: CritiqueParams): string {
  const promptLower = params.prompt.toLowerCase();
  const toolsCount = params.toolsUsed.length;

  if (!params.success) {
    if (params.error?.includes("timeout")) {
      return "For long-running tasks, break operations into smaller asynchronous steps to avoid execution timeout.";
    }
    if (params.error?.includes("not found") || params.error?.includes("ENOENT")) {
      return "Verify existence of target files and directories before executing modification commands.";
    }
    if (params.error?.includes("permission") || params.error?.includes("EACCES")) {
      return "Check security permissions and avoid protected paths before executing privileged commands.";
    }
    return `When executing ${params.prompt.slice(0, 40)}..., validate intermediate tool arguments to prevent failures.`;
  }

  // If successful but used excessive tools
  if (toolsCount > 5) {
    return "Prioritize targeted inspection over broad exploratory commands to achieve goals within minimal tool budgets.";
  }

  // Domain-specific lessons
  if (promptLower.includes("git") || promptLower.includes("commit")) {
    return "Check git status and inspect modified diffs prior to staging to ensure atomic, clean commits.";
  }

  if (promptLower.includes("docker") || promptLower.includes("container")) {
    return "Check container health and port bindings immediately after container launch.";
  }

  if (promptLower.includes("test") || promptLower.includes("eval")) {
    return "Run isolated unit tests first to isolate regressions before launching large batch evaluation runs.";
  }

  if (promptLower.includes("search") || promptLower.includes("find")) {
    return "Use precise grep and semantic queries rather than traversing unindexed directory trees.";
  }

  return `Directly address the user's intent with grounded reasoning and concise confirmation.`;
}
