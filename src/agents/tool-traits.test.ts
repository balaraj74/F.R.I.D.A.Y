import { describe, expect, it, vi } from "vitest";

import {
  capToolResult,
  isTransientToolError,
  toolTraits,
  wrapToolWithTraits,
} from "./tool-traits.js";
import type { AnyAgentTool } from "./tools/common.js";

const ok = (text: string) => ({ content: [{ type: "text", text }], details: {} });

function fakeTool(name: string, execute: (...a: unknown[]) => Promise<unknown>): AnyAgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: {} as never,
    execute,
  } as unknown as AnyAgentTool;
}

describe("tool traits", () => {
  it("treats read-only tools as idempotent and everything else as side-effecting", () => {
    expect(toolTraits("web_search")).toMatchObject({ risk: "read", idempotent: true, retries: 2 });
    expect(toolTraits("exec")).toMatchObject({ risk: "act", idempotent: false, retries: 0 });
    expect(toolTraits("message")).toMatchObject({ idempotent: false });
    expect(toolTraits("memory_forget")).toMatchObject({ idempotent: false });
  });

  it("recognises transient failures only", () => {
    expect(isTransientToolError(new Error("fetch failed"))).toBe(true);
    expect(isTransientToolError(new Error("HTTP 429 Too Many Requests"))).toBe(true);
    expect(isTransientToolError(new Error("upstream returned 503"))).toBe(true);
    expect(isTransientToolError(new Error("ENOENT: no such file"))).toBe(false);
    expect(isTransientToolError(new Error("invalid query parameter"))).toBe(false);
  });

  it("retries an idempotent tool after a transient error", async () => {
    const exec = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(ok("results"));
    const tool = wrapToolWithTraits(fakeTool("web_search", exec), { backoffMs: 1 });
    await expect(tool.execute!("c1", {}, undefined, undefined)).resolves.toEqual(ok("results"));
    expect(exec).toHaveBeenCalledTimes(2);
    expect((tool as { parallelSafe?: boolean }).parallelSafe).toBe(true);
  });

  it("never retries a side-effecting tool, even on a transient error", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const tool = wrapToolWithTraits(fakeTool("message", exec), { backoffMs: 1 });
    await expect(tool.execute!("c1", {}, undefined, undefined)).rejects.toThrow("ECONNRESET");
    expect(exec).toHaveBeenCalledTimes(1);
    expect((tool as { parallelSafe?: boolean }).parallelSafe).toBe(false);
  });

  it("does not retry logic errors", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("invalid url"));
    const tool = wrapToolWithTraits(fakeTool("web_fetch", exec), { backoffMs: 1 });
    await expect(tool.execute!("c1", {}, undefined, undefined)).rejects.toThrow("invalid url");
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("times out a hung read-only tool", async () => {
    const tool = wrapToolWithTraits(
      fakeTool("web_fetch", () => new Promise(() => {})),
      {
        traits: { risk: "read", idempotent: true, timeoutMs: 20, retries: 0 },
      },
    );
    await expect(tool.execute!("c1", {}, undefined, undefined)).rejects.toThrow(/timed out/);
  });

  it("caps oversized text results, keeping head and tail", () => {
    const big = "A".repeat(50_000) + "MIDDLE" + "Z".repeat(50_000);
    const capped = capToolResult(ok(big));
    const text = capped.content[0].text!;
    expect(text.length).toBeLessThan(60_000);
    expect(text.startsWith("AAAA")).toBe(true);
    expect(text.endsWith("ZZZZ")).toBe(true);
    expect(text).toContain("characters omitted");
    expect(capToolResult(ok("small"))).toEqual(ok("small"));
  });
});
