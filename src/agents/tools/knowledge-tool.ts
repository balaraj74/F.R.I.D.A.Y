import { Type } from "@sinclair/typebox";

import {
  addFact,
  forgetEntity,
  forgetFact,
  listEntities,
  lookup,
  search,
} from "../knowledge/graph.js";
import { optionalStringEnum, stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

const ACTIONS = ["lookup", "search", "list", "add", "forget"] as const;
const TYPES = ["person", "organization", "project", "place", "thing", "event"] as const;

const KnowledgeSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      "lookup = everything known about one entity (current facts + history); search = find entities/facts by text; " +
      "list = known entities (optionally by type); add = record a fact; forget = remove an entity or a fact",
  }),
  name: Type.Optional(Type.String({ description: "lookup/forget: entity name" })),
  query: Type.Optional(Type.String({ description: "search: text to find" })),
  type: optionalStringEnum(TYPES, { description: "list/add: entity type" }),
  subject: Type.Optional(
    Type.String({ description: "add: who/what the fact is about (use 'Sir' for the user)" }),
  ),
  relation: Type.Optional(
    Type.String({ description: "add: snake_case relation, e.g. works_at, lives_in, owns, likes" }),
  ),
  object: Type.Optional(Type.String({ description: "add: the other entity, or a literal value" })),
  objectIsEntity: Type.Optional(
    Type.Boolean({
      description: "add: false when object is a literal value (date, email, number)",
    }),
  ),
  fact: Type.Optional(Type.String({ description: "add: the fact as one plain sentence" })),
  factId: Type.Optional(Type.Number({ description: "forget: id of a single fact to remove" })),
});

export function createKnowledgeTool(options: { agentSessionKey?: string } = {}): AnyAgentTool {
  return {
    label: "Knowledge Graph",
    name: "knowledge",
    description:
      "Sir's knowledge graph: people, organizations, projects, places and how they connect, with dated facts " +
      "(old facts are kept as history when they change). Use `lookup` before answering questions about a person or " +
      "project, `add` when Sir tells you a durable fact about someone or something, `forget` when he asks.",
    parameters: KnowledgeSchema,
    execute: async (_toolCallId, params) => {
      const action = readStringParam(params, "action", { required: true });
      switch (action) {
        case "lookup": {
          const name = readStringParam(params, "name", { required: true });
          return jsonResult(lookup(name) ?? { found: false, name });
        }
        case "search":
          return jsonResult(search(readStringParam(params, "query", { required: true })));
        case "list":
          return jsonResult({ entities: listEntities(readStringParam(params, "type")) });
        case "add": {
          const res = addFact({
            subject: readStringParam(params, "subject", { required: true }),
            relation: readStringParam(params, "relation", { required: true }),
            object: readStringParam(params, "object", { required: true }),
            objectIsEntity: (params as { objectIsEntity?: boolean }).objectIsEntity !== false,
            objectType: readStringParam(params, "type"),
            fact: readStringParam(params, "fact"),
            source: `manual:${options.agentSessionKey ?? ""}`,
            confidence: 0.95,
          });
          return jsonResult(res);
        }
        case "forget": {
          const factId = readNumberParam(params, "factId");
          if (factId !== undefined) return jsonResult({ forgotten: forgetFact(factId) });
          return jsonResult({
            forgotten: forgetEntity(readStringParam(params, "name", { required: true })),
          });
        }
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}
