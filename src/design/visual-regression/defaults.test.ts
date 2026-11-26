import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { comparePngs, readFileIfExists, writeFileAtomic } from "./defaults.js";

async function solid(width: number, height: number, rgb: [number, number, number]) {
  return sharp({
    create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } },
  })
    .png()
    .toBuffer();
}

describe("comparePngs", () => {
  it("reports 0 for identical images and no diff image", async () => {
    const img = await solid(10, 10, [10, 20, 30]);
    expect(await comparePngs(img, img, { channelThreshold: 0 })).toEqual({ diffPixels: 0 });
  });

  it("counts differing pixels and returns a PNG diff image", async () => {
    const a = await solid(10, 10, [0, 0, 0]);
    // Overlay a 2x3 white block.
    const b = await sharp(a)
      .composite([
        {
          input: await solid(2, 3, [255, 255, 255]),
          left: 1,
          top: 1,
        },
      ])
      .png()
      .toBuffer();
    const result = await comparePngs(a, b, { channelThreshold: 0 });
    expect(result.diffPixels).toBe(6);
    const meta = await sharp(result.diffImage).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["png", 10, 10]);
  });

  it("ignores channel differences within the threshold", async () => {
    const a = await solid(4, 4, [100, 100, 100]);
    const b = await solid(4, 4, [103, 100, 100]);
    expect((await comparePngs(a, b, { channelThreshold: 3 })).diffPixels).toBe(0);
    expect((await comparePngs(a, b, { channelThreshold: 2 })).diffPixels).toBe(16);
  });

  it("counts the uncovered area when sizes differ", async () => {
    const a = await solid(4, 4, [0, 0, 0]);
    const b = await solid(6, 4, [0, 0, 0]);
    expect((await comparePngs(a, b, { channelThreshold: 0 })).diffPixels).toBe(8);
  });
});

describe("file helpers", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "vr-defaults-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("readFileIfExists returns undefined for a missing file", async () => {
    expect(await readFileIfExists(path.join(dir, "none.png"))).toBeUndefined();
  });

  it("writeFileAtomic creates parent directories and leaves no temp file", async () => {
    const target = path.join(dir, "a", "b.png");
    await writeFileAtomic(target, Buffer.from("x"));
    expect((await readFileIfExists(target))?.toString()).toBe("x");
    expect(await fs.readdir(path.join(dir, "a"))).toEqual(["b.png"]);
  });
});
