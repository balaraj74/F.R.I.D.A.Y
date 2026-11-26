import { Type } from "@sinclair/typebox";

import {
  attentionCommitments,
  describeCommitment,
  dueBucket,
  loadCommitments,
  updateCommitment,
  upsertCommitment,
} from "../commitments/store.js";
import { optionalStringEnum, stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const ACTIONS = ["list", "due", "add", "done", "dismiss", "snooze"] as const;

const CommitmentsSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      "list = all open; due = overdue/due today; add = track a new one; done/dismiss = close by id; snooze = hide until `until`",
  }),
  id: Type.Optional(
    Type.String({ description: "Commitment id (c_xxxxxx) for done/dismiss/snooze" }),
  ),
  text: Type.Optional(
    Type.String({
      description: "add: what must happen, short imperative ('Send the deck to Ravi')",
    }),
  ),
  who: Type.Optional(Type.String({ description: "add: the other person involved" })),
  owner: optionalStringEnum(["sir", "other", "friday"] as const, {
    description:
      "add: who owes it. sir (default) | other (someone owes Sir) | friday (you promised it)",
  }),
  due: Type.Optional(
    Type.String({ description: "add: deadline as ISO 8601 with timezone offset" }),
  ),
  dueText: Type.Optional(
    Type.String({ description: "add: deadline as Sir said it ('by Friday')" }),
  ),
  until: Type.Optional(Type.String({ description: "snooze: ISO 8601 time to hide it until" })),
});

export function createCommitmentsTool(options: { agentSessionKey?: string } = {}): AnyAgentTool {
  return {
    label: "Commitments",
    name: "commitments",
    description:
      "Sir's tracked promises and deadlines (things he owes people, things people owe him, things you promised). " +
      "Use `due` to see what needs attention, `add` when Sir commits to something or asks you to keep track, " +
      "and `done`/`dismiss` when it's handled. New ones are also picked up from conversations automatically.",
    parameters: CommitmentsSchema,
    execute: async (_toolCallId, params) => {
      const action = readStringParam(params, "action", { required: true });
      const now = new Date();
      switch (action) {
        case "list": {
          const open = loadCommitments().filter((c) => c.status === "open");
          return jsonResult({
            open: open.map((c) => ({
              ...c,
              bucket: dueBucket(c, now),
              summary: describeCommitment(c, now),
            })),
          });
        }
        case "due": {
          const items = attentionCommitments(loadCommitments(), now);
          return jsonResult({
            due: items.map((c) => ({
              id: c.id,
              bucket: c.bucket,
              summary: describeCommitment(c, now),
            })),
          });
        }
        case "add": {
          const text = readStringParam(params, "text", { required: true });
          const dueRaw = readStringParam(params, "due");
          if (dueRaw && Number.isNaN(Date.parse(dueRaw)))
            throw new Error("due must be an ISO 8601 date-time");
          const owner = readStringParam(params, "owner");
          const { commitment, created } = upsertCommitment({
            text,
            who: readStringParam(params, "who"),
            owner: owner === "other" || owner === "friday" ? owner : "sir",
            due: dueRaw ? new Date(dueRaw).toISOString() : undefined,
            dueText: readStringParam(params, "dueText"),
            source: { kind: "manual", sessionKey: options.agentSessionKey, at: now.toISOString() },
          });
          return jsonResult({ created, commitment, summary: describeCommitment(commitment, now) });
        }
        case "done":
        case "dismiss":
        case "snooze": {
          const id = readStringParam(params, "id", { required: true });
          let patch: Parameters<typeof updateCommitment>[1];
          if (action === "snooze") {
            const until = readStringParam(params, "until", { required: true });
            if (Number.isNaN(Date.parse(until)))
              throw new Error("until must be an ISO 8601 date-time");
            patch = { snoozedUntil: new Date(until).toISOString() };
          } else {
            patch = { status: action === "done" ? "done" : "dismissed" };
          }
          const updated = updateCommitment(id, patch);
          if (!updated) throw new Error(`No commitment with id ${id}`);
          return jsonResult({ updated: describeCommitment(updated, now), status: updated.status });
        }
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}
