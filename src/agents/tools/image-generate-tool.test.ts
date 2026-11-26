import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createImageGenerateTool, extractImage } from "./image-generate-tool.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "imggen-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const PNG = Buffer.from("fake-png-bytes").toString("base64");
const reply = (content: unknown, ok = true, status = 200) =>
  (async () => ({
    ok,
    status,
    json: async () => ({ content }),
    text: async () => "boom",
  })) as never;

const run = (
  fetchImpl: never,
  params: Record<string, unknown> = { prompt: "a red robot waving" },
) => createImageGenerateTool({ workspaceDir: dir, fetchImpl }).execute("id", params as never);

describe("extractImage", () => {
  it("finds the picture and the words beside it, ignoring thinking", () => {
    const got = extractImage([
      { type: "thinking", thinking: "hmm" },
      { type: "image", source: { media_type: "image/jpeg", data: "AAA" } },
      { type: "text", text: "Here you go" },
    ]);
    expect(got).toEqual({ mime: "image/jpeg", data: "AAA", text: "Here you go" });
    expect(extractImage([{ type: "text", text: "no" }])).toBeNull();
  });
});

describe("image_generate", () => {
  it("saves the picture in the temp folder, not the workspace, and hands back a MEDIA line", async () => {
    const res = await run(
      reply([{ type: "image", source: { media_type: "image/png", data: PNG } }]),
    );
    const file = (res.details as { path: string }).path;
    expect(file.startsWith(path.join(os.tmpdir(), ""))).toBe(true);
    expect(file.startsWith(dir)).toBe(false);
    expect(file).toMatch(/a-red-robot-waving\.png$/);
    expect(fs.readFileSync(file).toString()).toBe("fake-png-bytes");
    expect((res.content[0] as { text: string }).text).toContain(`MEDIA:${file}`);
  });

  it("sends a reference image for edits", async () => {
    const ref = path.join(dir, "logo.png");
    fs.writeFileSync(ref, "x");
    let body = "";
    const spy = (async (_u: string, init: { body: string }) => {
      body = init.body;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          content: [{ type: "image", source: { media_type: "image/png", data: PNG } }],
        }),
      };
    }) as never;
    await run(spy, { prompt: "make it blue", reference: ref });
    expect(JSON.parse(body).messages[0].content[0].type).toBe("image");
  });

  it("explains a refusal, an HTTP error and a missing reference plainly", async () => {
    await expect(run(reply([{ type: "text", text: "I can't" }]))).rejects.toThrow(/no picture/);
    await expect(run(reply([], false, 500))).rejects.toThrow(/HTTP 500/);
    await expect(
      run(reply([]), { prompt: "x", reference: path.join(dir, "nope.png") }),
    ).rejects.toThrow();
  });
});
