import fs from "node:fs";
import path from "node:path";

import { Type } from "@sinclair/typebox";

import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

// Sir's n8n (started with the app, friday-hud/electron/containers.cjs). Workflows are fixed rules
// he builds in n8n's editor; FRIDAY triggers them through their webhooks and can list them once he
// has created an API key in n8n (Settings → n8n API) and saved it to ~/.friday/n8n-api-key.
const N8N_URL = process.env.FRIDAY_N8N_URL ?? "http://127.0.0.1:18961";
const keyFile = () => path.join(process.env.HOME ?? "", ".friday", "n8n-api-key");

const ACTIONS = ["list", "trigger", "editor"] as const;

const AutomationsSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      "list = Sir's n8n workflows; trigger = run one through its webhook; editor = where Sir builds them",
  }),
  path: Type.Optional(
    Type.String({ description: "trigger: the workflow's webhook path, e.g. 'daily-digest'" }),
  ),
  data: Type.Optional(Type.String({ description: "trigger: JSON object to send to the workflow" })),
});

async function call(url: string, init: RequestInit = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) }).catch((err) => {
    throw new Error(`n8n isn't reachable (${String(err)}). It starts with FRIDAY's INITIALIZE.`);
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // plain-text response
  }
  if (!res.ok) throw new Error(`n8n answered ${res.status}: ${text.slice(0, 300)}`);
  return body;
}

export function createAutomationsTool(): AnyAgentTool {
  return {
    label: "Automations",
    name: "automations",
    description:
      "Sir's n8n automations (fixed workflows such as 'when X happens, do Y'). Use `list` to see them and " +
      "`trigger` to run one by its webhook path. To build or change a workflow, point Sir to the `editor`.",
    parameters: AutomationsSchema,
    execute: async (_toolCallId, params) => {
      const action = readStringParam(params, "action", { required: true });
      if (action === "editor")
        return jsonResult({ url: N8N_URL, note: "Open in a browser on this computer." });
      if (action === "list") {
        let key = "";
        try {
          key = fs.readFileSync(keyFile(), "utf-8").trim();
        } catch {
          return jsonResult({
            workflows: null,
            note: `Listing needs an n8n API key: in ${N8N_URL} go to Settings → n8n API, create one, and save it to ~/.friday/n8n-api-key.`,
          });
        }
        const res = (await call(`${N8N_URL}/api/v1/workflows?limit=100`, {
          headers: { "X-N8N-API-KEY": key },
        })) as {
          data?: Array<{
            id: string;
            name: string;
            active: boolean;
            nodes?: Array<{ type: string; parameters?: { path?: string } }>;
          }>;
        };
        return jsonResult({
          workflows: (res.data ?? []).map((w) => ({
            id: w.id,
            name: w.name,
            active: w.active,
            webhooks: (w.nodes ?? [])
              .filter((n) => n.type === "n8n-nodes-base.webhook" && n.parameters?.path)
              .map((n) => n.parameters!.path),
          })),
        });
      }
      if (action === "trigger") {
        const hook = readStringParam(params, "path", { required: true }).replace(/^\/+/, "");
        if (!/^[\w\-/]+$/.test(hook))
          throw new Error("Webhook path may only contain letters, digits, - _ and /.");
        const raw = readStringParam(params, "data");
        const data = raw ? (JSON.parse(raw) as unknown) : {};
        const result = await call(`${N8N_URL}/webhook/${hook}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(data),
        });
        return jsonResult({ triggered: hook, result });
      }
      throw new Error(`Unknown action: ${action}`);
    },
  };
}
