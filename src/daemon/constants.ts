// Default service labels (for backward compatibility and when no profile specified)
export const GATEWAY_LAUNCH_AGENT_LABEL = "bot.molt.gateway";
export const GATEWAY_SYSTEMD_SERVICE_NAME = "friday-gateway";
export const GATEWAY_WINDOWS_TASK_NAME = "FRIDAY Gateway";
export const GATEWAY_SERVICE_MARKER = "friday";
export const GATEWAY_SERVICE_KIND = "gateway";
export const NODE_LAUNCH_AGENT_LABEL = "bot.molt.node";
export const NODE_SYSTEMD_SERVICE_NAME = "friday-node";
export const NODE_WINDOWS_TASK_NAME = "FRIDAY Node";
export const NODE_SERVICE_MARKER = "friday";
export const NODE_SERVICE_KIND = "node";
export const NODE_WINDOWS_TASK_SCRIPT_NAME = "node.cmd";
export const LEGACY_GATEWAY_LAUNCH_AGENT_LABELS = [
  "com.friday.gateway",
  "com.steipete.friday.gateway",
];
export const LEGACY_GATEWAY_SYSTEMD_SERVICE_NAMES: string[] = [];
export const LEGACY_GATEWAY_WINDOWS_TASK_NAMES: string[] = [];

export function normalizeGatewayProfile(profile?: string): string | null {
  const trimmed = profile?.trim();
  if (!trimmed || trimmed.toLowerCase() === "default") return null;
  return trimmed;
}

export function resolveGatewayProfileSuffix(profile?: string): string {
  const normalized = normalizeGatewayProfile(profile);
  return normalized ? `-${normalized}` : "";
}

export function resolveGatewayLaunchAgentLabel(profile?: string): string {
  const normalized = normalizeGatewayProfile(profile);
  if (!normalized) {
    return GATEWAY_LAUNCH_AGENT_LABEL;
  }
  return `bot.molt.${normalized}`;
}

export function resolveLegacyGatewayLaunchAgentLabels(profile?: string): string[] {
  const normalized = normalizeGatewayProfile(profile);
  if (!normalized) {
    return [...LEGACY_GATEWAY_LAUNCH_AGENT_LABELS];
  }
  return [...LEGACY_GATEWAY_LAUNCH_AGENT_LABELS, `com.friday.${normalized}`];
}

export function resolveGatewaySystemdServiceName(profile?: string): string {
  const suffix = resolveGatewayProfileSuffix(profile);
  if (!suffix) return GATEWAY_SYSTEMD_SERVICE_NAME;
  return `friday-gateway${suffix}`;
}

export function resolveGatewayWindowsTaskName(profile?: string): string {
  const normalized = normalizeGatewayProfile(profile);
  if (!normalized) return GATEWAY_WINDOWS_TASK_NAME;
  return `FRIDAY Gateway (${normalized})`;
}

export function formatGatewayServiceDescription(params?: {
  profile?: string;
  version?: string;
}): string {
  const profile = normalizeGatewayProfile(params?.profile);
  const version = params?.version?.trim();
  const parts: string[] = [];
  if (profile) parts.push(`profile: ${profile}`);
  if (version) parts.push(`v${version}`);
  if (parts.length === 0) return "FRIDAY Gateway";
  return `FRIDAY Gateway (${parts.join(", ")})`;
}

export function resolveNodeLaunchAgentLabel(): string {
  return NODE_LAUNCH_AGENT_LABEL;
}

export function resolveNodeSystemdServiceName(): string {
  return NODE_SYSTEMD_SERVICE_NAME;
}

export function resolveNodeWindowsTaskName(): string {
  return NODE_WINDOWS_TASK_NAME;
}

export function formatNodeServiceDescription(params?: { version?: string }): string {
  const version = params?.version?.trim();
  if (!version) return "FRIDAY Node Host";
  return `FRIDAY Node Host (v${version})`;
}
