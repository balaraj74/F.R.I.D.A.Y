import type { AgentTool } from "@earendil-works/pi-agent-core";

// biome-ignore lint/suspicious/noExplicitAny: TypeBox schema type from pi-agent-core uses a different module instance.
export type AnyAgentTool = AgentTool<any, unknown>;
