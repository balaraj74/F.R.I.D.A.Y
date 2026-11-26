import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { addTombstone, loadTombstones, matchesTombstone, removeLinesContaining } from "./forget.js";

describe("memory forget tombstones", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-forget-"));
    file = path.join(dir, "forgotten.json");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("records phrases once and matches case/whitespace-insensitively", async () => {
    await addTombstone(file, "Old  Bank PIN");
    await addTombstone(file, "old bank pin");
    const tombs = loadTombstones(file);
    expect(tombs).toHaveLength(1);
    expect(matchesTombstone("Note: my old bank\npin is in the drawer", tombs)).toBe(true);
    expect(matchesTombstone("new bank app installed", tombs)).toBe(false);
  });

  it("returns nothing when the tombstone file is missing or corrupt", async () => {
    expect(loadTombstones(file)).toEqual([]);
    await fs.writeFile(file, "{not json", "utf-8");
    expect(loadTombstones(file)).toEqual([]);
  });

  it("removes only lines that mention the phrase", () => {
    const { content, removed } = removeLinesContaining(
      "# MEMORY\n- Ex: Priya\n- Project: Cinetra\n- priya's birthday: May\n",
      "priya",
    );
    expect(removed).toBe(2);
    expect(content).toBe("# MEMORY\n- Project: Cinetra\n");
  });
});
