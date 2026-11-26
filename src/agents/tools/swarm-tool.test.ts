import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
let inFlight = 0;
let maxInFlight = 0;
const replies = new Map<string, string>();

vi.mock("../../gateway/call.js", () => ({
  callGateway: vi.fn(
    async ({ method, params }: { method: string; params: Record<string, unknown> }) => {
      calls.push({ method, params });
      if (method === "agent") {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return { runId: `run:${params.sessionKey}` };
      }
      if (method === "agent.wait") {
        const key = String(params.runId).slice(4);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        if (key.endsWith("-broken")) return { status: "error", error: "model failed" };
        replies.set(
          key,
          key.endsWith("-reviewer")
            ? "Merged brief: A and B agree."
            : `report from ${key.split("-").pop()}`,
        );
        return { status: "ok" };
      }
      if (method === "chat.history") {
        const text = replies.get(String(params.sessionKey)) ?? "";
        return { messages: [{ role: "assistant", content: [{ type: "text", text }] }] };
      }
      return {};
    },
  ),
}));

import { createSwarmTool } from "./swarm-tool.js";

beforeEach(() => {
  calls.length = 0;
  inFlight = 0;
  maxInFlight = 0;
  replies.clear();
});

describe("swarm tool", () => {
  it("runs specialists in parallel, reviews, reports failures, and cleans up", async () => {
    const tool = createSwarmTool({ config: {} as never, agentId: "main" });
    const res = await tool.execute("t1", {
      goal: "Compare two laptops",
      agents: [
        { name: "alpha", role: "researcher", task: "Research laptop A" },
        { name: "beta", role: "researcher", task: "Research laptop B" },
        { name: "broken", role: "pricing", task: "Find prices" },
      ],
    });
    const d = res.details as {
      reports: Array<{ name: string; status: string; report: string }>;
      review?: { report: string };
    };
    expect(maxInFlight).toBe(3);
    expect(d.reports.map((r) => [r.name, r.status])).toEqual([
      ["alpha", "ok"],
      ["beta", "ok"],
      ["broken", "error"],
    ]);
    expect(d.reports[0].report).toBe("report from alpha");
    expect(d.review?.report).toBe("Merged brief: A and B agree.");
    const reviewerMsg = calls.find(
      (c) => c.method === "agent" && String(c.params.sessionKey).endsWith("-reviewer"),
    );
    expect(String(reviewerMsg?.params.message)).toContain("report from beta");
    // Each specialist knows the goal and its peers; children are cleaned up afterwards.
    const alphaStart = calls.find(
      (c) => c.method === "agent" && String(c.params.sessionKey).endsWith("-alpha"),
    );
    expect(String(alphaStart?.params.extraSystemPrompt)).toMatch(
      /Compare two laptops[\s\S]*beta \(researcher\)/,
    );
    expect(calls.filter((c) => c.method === "sessions.delete")).toHaveLength(4);
  });

  it("marks children of autonomous runs so trust gates still apply", async () => {
    const tool = createSwarmTool({ config: {} as never, agentId: "main", autonomous: true });
    await tool.execute("t2", {
      goal: "g",
      agents: [
        { name: "a", role: "r", task: "x" },
        { name: "b", role: "r", task: "y" },
      ],
    });
    const keys = calls.filter((c) => c.method === "agent").map((c) => String(c.params.sessionKey));
    expect(keys.every((k) => k.startsWith("agent:main:subagent:auto-swarm-"))).toBe(true);
  });
});
