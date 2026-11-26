import { agentLoop } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";

import { wrapToolWithTraits } from "./tool-traits.js";
import type { AnyAgentTool } from "./tools/common.js";

// Verifies FRIDAY's tool traits against pi's native tool execution (pi >= 0.8x): a batch of
// read-only calls runs concurrently; a batch containing any side-effecting tool runs one at a time.

type Span = { name: string; start: number; end: number };

function timedTool(name: string, spans: Span[], ms: number): AnyAgentTool {
  return wrapToolWithTraits({
    name,
    label: name,
    description: name,
    parameters: { type: "object", properties: {} } as never,
    execute: async () => {
      const start = performance.now();
      await new Promise((r) => setTimeout(r, ms));
      spans.push({ name, start, end: performance.now() });
      return { content: [{ type: "text", text: `${name} done` }], details: {} };
    },
  } as unknown as AnyAgentTool);
}

/** Fake model: first turn requests the given tool calls, second turn answers. */
function fakeStream(calls: Array<{ id: string; name: string }>) {
  let turn = 0;
  return () => {
    const message =
      turn++ === 0
        ? {
            role: "assistant",
            content: calls.map((c) => ({
              type: "toolCall",
              id: c.id,
              name: c.name,
              arguments: {},
            })),
            stopReason: "toolUse",
            timestamp: Date.now(),
          }
        : {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            stopReason: "stop",
            timestamp: Date.now(),
          };
    return {
      async *[Symbol.asyncIterator]() {
        yield { type: "done", message };
      },
      result: async () => message,
    };
  };
}

async function runBatch(tools: AnyAgentTool[], calls: Array<{ id: string; name: string }>) {
  const stream = agentLoop(
    [{ role: "user", content: [{ type: "text", text: "go" }], timestamp: Date.now() }] as never,
    { systemPrompt: "", messages: [], tools } as never,
    {
      model: { provider: "test", id: "test", api: "test" },
      convertToLlm: (m: unknown[]) => m,
    } as never,
    undefined,
    fakeStream(calls) as never,
  );
  return (await stream.result()) as Array<{ role: string; toolCallId?: string }>;
}

describe("parallel read-only tool calls", () => {
  it("overlaps a batch of read-only calls and keeps results in order", async () => {
    const spans: Span[] = [];
    const tools = [timedTool("web_search", spans, 120), timedTool("web_fetch", spans, 120)];
    const messages = await runBatch(tools, [
      { id: "a", name: "web_search" },
      { id: "b", name: "web_fetch" },
    ]);
    const search = spans.find((s) => s.name === "web_search")!;
    const fetch = spans.find((s) => s.name === "web_fetch")!;
    expect(fetch.start).toBeLessThan(search.end);
    expect(search.start).toBeLessThan(fetch.end);
    expect(messages.filter((m) => m.role === "toolResult").map((m) => m.toolCallId)).toEqual([
      "a",
      "b",
    ]);
  });

  it("runs a batch containing exec strictly one at a time, in order", async () => {
    const spans: Span[] = [];
    const tools = [
      timedTool("web_search", spans, 60),
      timedTool("exec", spans, 20),
      timedTool("web_fetch", spans, 60),
    ];
    const messages = await runBatch(tools, [
      { id: "a", name: "web_search" },
      { id: "b", name: "exec" },
      { id: "c", name: "web_fetch" },
    ]);
    expect(spans.map((s) => s.name)).toEqual(["web_search", "exec", "web_fetch"]);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]!.start).toBeGreaterThanOrEqual(spans[i - 1]!.end - 1);
    }
    expect(messages.filter((m) => m.role === "toolResult").map((m) => m.toolCallId)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});
