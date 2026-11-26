import type { Role } from "./types.js";

// Tool names match the agent tool registry. Matching is exact: no wildcards.
// researcher/reviewer cannot write or execute; only builder/operator/verifier can run commands.
export const ROLE_TOOL_ALLOWLIST: Readonly<Record<Role, readonly string[]>> = {
  researcher: [
    "web_search",
    "web_fetch",
    "browser",
    "memory_search",
    "memory_get",
    "knowledge",
    "read",
    "grep",
    "find",
    "ls",
  ],
  builder: [
    "read",
    "write",
    "edit",
    "apply_patch",
    "exec",
    "process",
    "grep",
    "find",
    "ls",
    "run_code",
    "code",
    "web_search",
    "web_fetch",
    "memory_search",
    "memory_get",
  ],
  operator: [
    "exec",
    "process",
    "read",
    "message",
    "cron",
    "automations",
    "commitments",
    "nodes",
    "browser",
    "web_fetch",
    "memory_search",
    "memory_get",
  ],
  reviewer: ["read", "grep", "find", "ls", "memory_search", "memory_get", "web_fetch"],
  verifier: ["read", "grep", "find", "ls", "exec", "run_code", "memory_get"],
};

export function isToolAllowed(role: Role, tool: string): boolean {
  const allowed = Object.hasOwn(ROLE_TOOL_ALLOWLIST, role) ? ROLE_TOOL_ALLOWLIST[role] : undefined;
  return allowed?.includes(tool) ?? false;
}
