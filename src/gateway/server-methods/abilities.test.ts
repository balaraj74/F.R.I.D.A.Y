import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config/config.js", () => ({ loadConfig: () => ({}) }));

import { abilitiesHandlers } from "./abilities.js";

let state: string;
let docs: string;
beforeEach(() => {
  state = fs.mkdtempSync(path.join(os.tmpdir(), "abilities-"));
  docs = path.join(state, "notes");
  fs.mkdirSync(docs);
  fs.writeFileSync(path.join(docs, "unit3.md"), "Normalisation removes redundancy.");
  vi.stubEnv("FRIDAY_STATE_DIR", state);
  // Nothing real should be probed.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false })),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fs.rmSync(state, { recursive: true, force: true });
});

const call = (method: keyof typeof abilitiesHandlers, params: object = {}) =>
  new Promise<{ ok: boolean; payload: any; error?: any }>((resolve) =>
    (abilitiesHandlers[method] as any)({
      params,
      respond: (ok: boolean, payload: unknown, error: unknown) => resolve({ ok, payload, error }),
    }),
  );

describe("abilities", () => {
  it("reports the state of each capability", async () => {
    const { ok, payload } = await call("abilities.status");
    expect(ok).toBe(true);
    expect(payload).toMatchObject({
      files: { folders: [], files: 0 },
      jobs: { active: 0, recent: [] },
      code: [],
      automations: { up: false },
      search: { up: false },
      screen: { approved: expect.any(Boolean) },
      benchmark: { latest: null, measurements: 0 },
    });
    expect(Array.isArray(payload.plugins)).toBe(true);
  });

  it("lets Sir add and remove an indexed folder", async () => {
    const added = await call("abilities.files.add", { folder: docs });
    expect(added.ok).toBe(true);
    expect(added.payload.folders).toEqual([docs]);
    const removed = await call("abilities.files.remove", { folder: docs });
    expect(removed.payload.folders).toEqual([]);
  });

  it("refuses bad folders with a clear error", async () => {
    expect((await call("abilities.files.add", {})).ok).toBe(false);
    const missing = await call("abilities.files.add", { folder: path.join(state, "nope") });
    expect(missing.ok).toBe(false);
    expect(JSON.stringify(missing.error)).toMatch(/Not a folder/);
    expect((await call("abilities.files.add", { folder: "/" })).ok).toBe(false);
  });
});
