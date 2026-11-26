import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { extractKnowledge } from "./extract.js";
import {
  addFact,
  closeGraph,
  contextFor,
  forgetEntity,
  lookup,
  openGraph,
  search,
  upsertEntity,
} from "./graph.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kg-"));
  vi.stubEnv("FRIDAY_STATE_DIR", dir);
  closeGraph();
});
afterEach(() => {
  closeGraph();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("knowledge graph", () => {
  it("links entities and refreshes repeated facts", () => {
    const db = openGraph(dir);
    expect(
      addFact(
        {
          subject: "Ravi",
          subjectType: "person",
          relation: "works at",
          object: "Acme Capital",
          objectType: "organization",
        },
        { db },
      ).created,
    ).toBe(true);
    expect(
      addFact({ subject: "ravi", relation: "works_at", object: "acme capital" }, { db }).created,
    ).toBe(false);
    const r = lookup("Ravi", db)!;
    expect(r.entity.type).toBe("person");
    expect(r.facts.map((f) => [f.relation, f.object])).toEqual([["works_at", "Acme Capital"]]);
    // Reverse direction is visible from the organisation too.
    expect(lookup("Acme Capital", db)!.facts).toHaveLength(1);
  });

  it("keeps history when a single-valued fact changes", () => {
    const db = openGraph(dir);
    addFact(
      { subject: "Priya", relation: "lives_in", object: "Pune" },
      { db, at: "2026-01-01T00:00:00Z" },
    );
    const res = addFact(
      { subject: "Priya", relation: "lives_in", object: "Bengaluru" },
      { db, at: "2026-06-01T00:00:00Z" },
    );
    expect(res.superseded).toBe(1);
    const r = lookup("Priya", db)!;
    expect(r.facts.map((f) => f.object)).toEqual(["Bengaluru"]);
    expect(r.history.map((f) => [f.object, f.invalidAt])).toEqual([
      ["Pune", "2026-06-01T00:00:00Z"],
    ]);
    // Multi-valued relations accumulate instead.
    addFact({ subject: "Priya", relation: "likes", object: "chess" }, { db });
    addFact({ subject: "Priya", relation: "likes", object: "jazz" }, { db });
    expect(lookup("Priya", db)!.facts.filter((f) => f.relation === "likes")).toHaveLength(2);
  });

  it("finds mentioned entities by whole word or alias for prompt context", () => {
    const db = openGraph(dir);
    addFact(
      { subject: "Ravi", subjectType: "person", relation: "invests_in", object: "Maya" },
      { db },
    );
    upsertEntity(
      { name: "Ravi", alias: "Ravi Kumar", summary: "investor Sir is pitching to" },
      { db },
    );
    upsertEntity({ name: "Sir", type: "person" }, { db });
    const ctx = contextFor("draft a mail to ravi kumar about the demo", { db });
    expect(ctx).toContain(
      "Ravi (person): investor Sir is pitching to. Known: Ravi invests in Maya",
    );
    expect(contextFor("I'm traveling tomorrow", { db })).toBe(""); // "ravi" inside "traveling" is not a mention
    expect(contextFor("Sir says hi", { db })).toBe("");
  });

  it("searches and forgets", () => {
    const db = openGraph(dir);
    addFact(
      {
        subject: "Novabion",
        subjectType: "organization",
        relation: "builds",
        object: "sericulture automation",
        objectIsEntity: false,
      },
      { db },
    );
    expect(search("sericulture", db).facts).toHaveLength(1);
    expect(forgetEntity("Novabion", db)).toBe(true);
    expect(lookup("Novabion", db)).toBeNull();
    expect(search("sericulture", db).facts).toHaveLength(0);
  });

  it("extracts facts from conversation lines with the fast brain", async () => {
    const complete = vi.fn(async () =>
      JSON.stringify([
        {
          subject: "Ravi",
          subject_type: "person",
          relation: "works_at",
          object: "Acme Capital",
          object_type: "organization",
          object_is_entity: true,
          fact: "Ravi works at Acme Capital",
          subject_summary: "investor",
          confidence: 0.9,
        },
        { subject: "FRIDAY", relation: "helps", object: "Sir", confidence: 0.9 },
        { subject: "Maybe", relation: "is", object: "vague", confidence: 0.2 },
      ]),
    );
    const at = new Date().toISOString();
    const res = await extractKnowledge({
      cfg: {} as never,
      lines: [
        {
          role: "user",
          text: "Ravi from Acme Capital wants the deck",
          at,
          sessionKey: "agent:main:main",
        },
      ],
      complete: complete as never,
    });
    expect(res).toEqual({ facts: 1, created: 1 });
    expect(lookup("Ravi")?.entity.summary).toBe("investor");
  });
});
