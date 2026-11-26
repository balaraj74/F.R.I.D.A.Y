import { Type } from "@sinclair/typebox";

import {
  pruneSandboxRuns,
  runSandboxed,
  sandboxAvailable,
  type SandboxLanguage,
} from "../sandbox-exec/bwrap.js";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const RunCodeSchema = Type.Object({
  language: stringEnum(["python", "node", "bash"] as const, { description: "Interpreter to use" }),
  code: Type.String({
    description:
      "Complete program. Files it writes stay in its scratch folder (returned as `workdir`).",
  }),
  timeoutSeconds: Type.Optional(
    Type.Number({ minimum: 1, maximum: 600, description: "Wall/CPU time limit (default 60)" }),
  ),
  network: Type.Optional(Type.Boolean({ description: "Allow internet access (default false)" })),
});

export function createRunCodeTool(): AnyAgentTool | null {
  if (!sandboxAvailable()) return null;
  return {
    label: "Run Code (sandbox)",
    name: "run_code",
    description:
      "Run Python, Node or Bash in an isolated sandbox: no access to Sir's files, no network unless network=true, " +
      "time and resource limits. Use it for calculations, data processing, parsing, quick experiments and scripts you " +
      "write yourself; it's safe to use on your own. It cannot change anything on the machine; use exec when Sir's " +
      "files or system really need changing.",
    parameters: RunCodeSchema,
    execute: async (_toolCallId, params, signal) => {
      const language = readStringParam(params, "language", { required: true }) as SandboxLanguage;
      const code = readStringParam(params, "code", { required: true, trim: false });
      const timeoutSeconds = (params as { timeoutSeconds?: number }).timeoutSeconds ?? 60;
      pruneSandboxRuns();
      const res = await runSandboxed({
        language,
        code,
        timeoutMs: timeoutSeconds * 1000,
        network: (params as { network?: boolean }).network === true,
        signal,
      });
      return jsonResult(res);
    },
  };
}
