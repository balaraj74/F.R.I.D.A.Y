// Requirement 15.5: the design and engine tracks must build and test without each other. Neither
// may import the other's files (the Jobs-views gate in src/design is the one allowed link, and it
// is a design-side file that does not import engine code).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../../..");
const IMPORT = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

function files(dir: string): string[] {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return [];
  return fs
    .readdirSync(abs, { recursive: true, encoding: "utf8" })
    .filter((f) => /\.tsx?$/.test(f))
    .map((f) => path.join(abs, f));
}

function offenders(dirs: string[], forbidden: string[]): string[] {
  const out: string[] = [];
  for (const file of dirs.flatMap(files)) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(IMPORT)) {
      const spec = m[1] as string;
      if (!spec.startsWith(".")) continue;
      const target = path.relative(root, path.resolve(path.dirname(file), spec));
      if (forbidden.some((f) => target === f || target.startsWith(`${f}${path.sep}`))) {
        out.push(`${path.relative(root, file)} -> ${spec}`);
      }
    }
  }
  return out;
}

describe("track isolation", () => {
  it("engine files do not import design files", () => {
    const engine = ["src/jobs", "tests/jobs-evals", "tests/jobs-chaos", "friday-hud/src/jobs"];
    const design = ["src/design", "friday-hud/src/design-review"];
    expect(offenders(engine, design)).toEqual([]);
  });
  it("design files do not import engine files", () => {
    const design = ["src/design", "friday-hud/src/design-review"];
    const engine = ["src/jobs", "tests/jobs-evals", "tests/jobs-chaos", "friday-hud/src/jobs"];
    expect(offenders(design, engine)).toEqual([]);
  });
});
