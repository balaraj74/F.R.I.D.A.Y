import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { chunkSection, extractText } from "./extract.js";
import { addRoot, indexStatus, listRoots, removeRoot, searchFiles, syncIndex } from "./index.js";

let state: string;
let docs: string;
beforeEach(() => {
  state = fs.mkdtempSync(path.join(os.tmpdir(), "files-index-"));
  docs = path.join(state, "docs");
  fs.mkdirSync(path.join(docs, "dbms"), { recursive: true });
  fs.mkdirSync(path.join(docs, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(
    path.join(docs, "dbms", "unit3.md"),
    "# Unit 3\n\nNormalisation removes redundancy. Third normal form (3NF) requires no transitive dependencies.",
  );
  fs.writeFileSync(
    path.join(docs, "careerlens-api.txt"),
    "CareerLens API spec: POST /jobs creates a job posting.",
  );
  fs.writeFileSync(
    path.join(docs, "node_modules", "pkg", "readme.md"),
    "normalisation in a dependency",
  );
  fs.writeFileSync(path.join(docs, "photo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});
afterEach(() => fs.rmSync(state, { recursive: true, force: true }));

describe("file index", () => {
  it("indexes chosen folders and finds passages with the file named", async () => {
    addRoot(docs, state);
    expect(await syncIndex(state)).toMatchObject({ indexed: 2 });
    const hits = searchFiles("normalisation 3NF", { stateDir: state });
    expect(hits).toHaveLength(1);
    expect(hits[0].path).toBe(path.join(docs, "dbms", "unit3.md"));
    expect(hits[0].snippet).toContain("«");
    // Stemming: "postings" finds "posting".
    expect(searchFiles("careerlens postings", { stateDir: state })[0]?.path).toContain(
      "careerlens-api.txt",
    );
    expect(indexStatus(state)).toMatchObject({ folders: [docs], files: 2 });
  });

  it("falls back to any word, filters by folder, and skips dependency folders", async () => {
    addRoot(docs, state);
    await syncIndex(state);
    expect(searchFiles("normalisation zebra", { stateDir: state })).toHaveLength(1);
    expect(
      searchFiles("normalisation", { folder: path.join(docs, "dbms"), stateDir: state }),
    ).toHaveLength(1);
    expect(searchFiles("dependency", { stateDir: state })).toHaveLength(1); // the .md, not node_modules
    expect(searchFiles("dependency", { stateDir: state })[0].path).not.toContain("node_modules");
  });

  it("re-reads changed files, drops deleted ones, and forgets removed folders", async () => {
    addRoot(docs, state);
    await syncIndex(state);
    const api = path.join(docs, "careerlens-api.txt");
    fs.writeFileSync(api, "CareerLens API spec: DELETE /jobs/:id archives a posting.");
    fs.utimesSync(api, new Date(), new Date(Date.now() + 5000));
    expect(await syncIndex(state)).toMatchObject({ indexed: 1, removed: 0 });
    expect(searchFiles("archives", { stateDir: state })).toHaveLength(1);
    fs.rmSync(path.join(docs, "dbms", "unit3.md"));
    expect(await syncIndex(state)).toMatchObject({ removed: 1 });
    removeRoot(docs, state);
    expect(listRoots(state)).toHaveLength(0);
    expect(indexStatus(state).files).toBe(0);
  });

  it("refuses the whole home folder or disk", () => {
    expect(() => addRoot("/", state)).toThrow(/specific folders/);
    expect(() => addRoot(path.join(state, "missing"), state)).toThrow(/Not a folder/);
  });
});

describe("extract", () => {
  it("reads notebooks cell by cell and skips binaries", async () => {
    const nb = path.join(state, "lab.ipynb");
    fs.writeFileSync(
      nb,
      JSON.stringify({ cells: [{ cell_type: "code", source: ["import pandas", "\n"] }] }),
    );
    expect(await extractText(nb)).toEqual([{ loc: "cell 1", text: "import pandas" }]);
    const bin = path.join(state, "fake.txt");
    fs.writeFileSync(bin, Buffer.from([1, 0, 2, 3]));
    expect(await extractText(bin)).toEqual([]);
  });

  it("chunks on paragraph boundaries", () => {
    const chunks = chunkSection(
      Array.from({ length: 10 }, (_, i) => `para ${i} `.repeat(30)).join("\n\n"),
      700,
    );
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((c) => c.length <= 700)).toBe(true);
  });
});
