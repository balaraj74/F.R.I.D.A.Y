import { describe, expect, it } from "vitest";
import { decideExit, scanFile } from "./index.js";

const SCALE = ["sm", "md", "4px", "8px"];
const rules = (content: string, generated = false) =>
  scanFile("a.tsx", content, SCALE, generated).map((v) => `${v.line}:${v.rule}`);

describe("scanFile", () => {
  it("flags hex colours of 3, 4, 6 and 8 digits but not 5 digits or ids", () => {
    expect(rules("a{color:#fff}\nb{color:#ffff}\nc{color:#ffffff}\nd{color:#ffffffff}")).toEqual([
      "1:hex-color",
      "2:hex-color",
      "3:hex-color",
      "4:hex-color",
    ]);
    expect(rules("x: #12345\n&#123;\n#abc-panel {}")).toEqual([]);
  });

  it("flags Tailwind arbitrary values with 1-based line numbers", () => {
    expect(rules('<div className="p-2\n w-[13px] hover:bg-[var(--x)]" />')).toEqual([
      "2:arbitrary-tailwind",
      "2:arbitrary-tailwind",
    ]);
  });

  it("flags gradient functions and Tailwind gradient utilities", () => {
    expect(rules("background: radial-gradient(red, blue);")).toEqual(["1:gradient"]);
    expect(rules('className="bg-gradient-to-r from-a to-b"')).toEqual(["1:gradient"]);
  });

  it("flags glow shadows but allows zero blur, no colour and elevation tokens", () => {
    expect(rules("box-shadow: 0 0 12px rgba(0,0,0,.4);")).toEqual(["1:glow-shadow"]);
    expect(rules("box-shadow:\n  0 1px 2px var(--elevation-1),\n  0 0 8px red;")).toEqual([
      "1:glow-shadow",
    ]);
    expect(rules('style={{ boxShadow: "0 0 10px blue" }}')).toEqual(["1:glow-shadow"]);
    expect(rules('className="shadow-[0_0_10px_red]"')).toEqual([
      "1:arbitrary-tailwind",
      "1:glow-shadow",
    ]);
    expect(rules("box-shadow: 0 0 0 red;")).toEqual([]);
    expect(rules("box-shadow: 0 2px 4px;")).toEqual([]);
    expect(rules("box-shadow: var(--elevation-2);")).toEqual([]);
  });

  it("flags radii outside the scale in CSS and Tailwind", () => {
    expect(rules("border-radius: 12px;")).toEqual(["1:bad-radius"]);
    expect(rules("border-radius: 8px 4px;")).toEqual([]);
    expect(rules("border-radius: var(--radius-md);")).toEqual([]);
    expect(rules("border-top-left-radius: 50%;")).toEqual(["1:bad-radius"]);
    expect(rules('className="rounded-lg"')).toEqual(["1:bad-radius"]);
    expect(rules('className="rounded-md md:rounded-t-sm"')).toEqual([]);
    expect(rules('className="rounded"')).toEqual(["1:bad-radius"]);
    expect(rules("const rounded = true;")).toEqual([]);
  });

  it("applies generated-file exemptions only to hex-color, glow-shadow and bad-radius", () => {
    const content = [
      "--c: #fff;",
      "box-shadow: 0 0 8px red;",
      "border-radius: 99px;",
      "background: linear-gradient(red, blue);",
      "width: w-[3px];",
    ].join("\n");
    expect(rules(content, true)).toEqual(["4:gradient", "5:arbitrary-tailwind"]);
    expect(rules(content, false)).toHaveLength(5);
  });

  it("returns nothing for clean content", () => {
    expect(rules("color: var(--color-fg);\nborder-radius: 4px;")).toEqual([]);
  });
});

describe("decideExit", () => {
  it("fails only when violations exceed the baseline", () => {
    expect(decideExit(5, 4)).toEqual({ exitCode: 1 });
    expect(decideExit(4, 4)).toEqual({ exitCode: 0 });
    expect(decideExit(0, 4)).toEqual({ exitCode: 0 });
  });
});
