// Feeds the knowledge graph from Sir's conversations: the fast brain pulls out entities and
// relationships from new transcript lines (same scan as commitments).

import type { FRIDAYConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { ConversationLine } from "../commitments/extract.js";
import { parseExtraction } from "../commitments/extract.js";
import { fastComplete } from "../fast-brain.js";
import { addFact, upsertEntity } from "./graph.js";

const log = createSubsystemLogger("knowledge");
const MAX_CHARS_PER_CALL = 12_000;
const TYPES = new Set(["person", "organization", "project", "place", "thing", "event"]);

const SYSTEM = `You build a knowledge graph of Sir's world from his conversation with FRIDAY (his assistant).
Extract durable facts about real people, organizations, projects, places and things in Sir's life:
who someone is, where they work, relationships, what a project is, preferences Sir stated, ownership, locations.
Refer to the user as "Sir". Skip: FRIDAY herself, small talk, one-off tasks, questions, speculation, code details.
Return ONLY a JSON array of facts (possibly empty):
[{"subject": "Ravi", "subject_type": "person", "relation": "works_at" (snake_case),
  "object": "Acme Capital", "object_type": "organization", "object_is_entity": true,
  "fact": "Ravi works at Acme Capital as an investor", "subject_summary": "investor Sir is pitching to" or null,
  "confidence": 0..1}]
Use object_is_entity false for literal values (emails, dates, numbers, short descriptions).`;

type Item = {
  subject?: string;
  subject_type?: string;
  relation?: string;
  object?: string;
  object_type?: string;
  object_is_entity?: boolean;
  fact?: string;
  subject_summary?: string | null;
  confidence?: number;
};

const typeOf = (t?: string) => (t && TYPES.has(t) ? t : undefined);

export async function extractKnowledge(params: {
  cfg: FRIDAYConfig;
  lines: ConversationLine[];
  now?: Date;
  complete?: typeof fastComplete;
}): Promise<{ facts: number; created: number }> {
  const complete = params.complete ?? fastComplete;
  const at = (params.now ?? new Date()).toISOString();
  let facts = 0;
  let created = 0;
  let chunk: string[] = [];
  let size = 0;
  let sessionKey = "";
  const flush = async () => {
    if (!chunk.some((l) => l.startsWith("Sir ["))) {
      chunk = [];
      size = 0;
      return;
    }
    const raw = await complete({
      cfg: params.cfg,
      system: SYSTEM,
      prompt: chunk.join("\n"),
      maxTokens: 6000,
      timeoutMs: 90_000,
    });
    chunk = [];
    size = 0;
    for (const item of parseExtraction(raw) as Item[]) {
      if (!item.subject || !item.relation || !item.object || (item.confidence ?? 0) < 0.6) continue;
      if (/^friday$/i.test(item.subject.trim()) || /^friday$/i.test(item.object.trim())) continue;
      facts++;
      if (item.subject_summary)
        upsertEntity(
          { name: item.subject, type: typeOf(item.subject_type), summary: item.subject_summary },
          { at },
        );
      const res = addFact(
        {
          subject: item.subject,
          subjectType: typeOf(item.subject_type),
          relation: item.relation,
          object: item.object,
          objectType: typeOf(item.object_type),
          objectIsEntity: item.object_is_entity !== false,
          fact: item.fact,
          source: sessionKey,
          confidence: item.confidence,
        },
        { at },
      );
      if (res.created) created++;
    }
  };
  for (const l of params.lines) {
    if (sessionKey && l.sessionKey !== sessionKey && chunk.length) await flush();
    sessionKey = l.sessionKey;
    const line = `${l.role === "user" ? "Sir" : "FRIDAY"} [${l.at.slice(0, 16)}]: ${l.text}`;
    if (size + line.length > MAX_CHARS_PER_CALL && chunk.length) await flush();
    chunk.push(line);
    size += line.length;
  }
  if (chunk.length) await flush();
  if (created) log.info(`added ${created} new fact(s) to the knowledge graph`);
  return { facts, created };
}
