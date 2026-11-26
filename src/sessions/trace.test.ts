import { describe, expect, it } from "vitest";

import { formatTrace, parseTrace } from "./trace.js";

const line = (o: unknown) => JSON.stringify(o);
const T0 = Date.UTC(2026, 9, 22, 10, 0, 0);

const transcript = [
  line({ type: "session", id: "s1" }),
  line({
    type: "message",
    message: {
      role: "user",
      content: [{ type: "text", text: "check the auth tests" }],
      timestamp: T0,
    },
  }),
  line({
    type: "message",
    message: {
      role: "assistant",
      timestamp: T0 + 1000,
      content: [
        { type: "toolCall", id: "t1", name: "exec", arguments: { command: "pnpm test src/auth" } },
        { type: "toolCall", id: "t2", name: "read", arguments: { path: "src/auth/session.ts" } },
      ],
    },
  }),
  line({
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "t2",
      content: [{ type: "text", text: "export function x() {}" }],
      timestamp: T0 + 1200,
    },
  }),
  line({
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "t1",
      isError: true,
      content: [{ type: "text", text: "FAIL rejects expired token" }],
      timestamp: T0 + 4000,
    },
  }),
  line({
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "One auth test fails: expired tokens." }],
      timestamp: T0 + 5000,
    },
  }),
  "not json",
].join("\n");

describe("session trace", () => {
  it("rebuilds tool calls with results, errors and durations", () => {
    const steps = parseTrace(transcript);
    expect(steps.map((s) => s.kind)).toEqual(["user", "tool", "tool", "reply"]);
    const exec = steps[1] as Extract<(typeof steps)[number], { kind: "tool" }>;
    expect(exec).toMatchObject({ name: "exec", isError: true, durationMs: 3000 });
    expect(steps[2]).toMatchObject({ name: "read", isError: false, durationMs: 200 });
  });

  it("formats a readable timeline", () => {
    const out = formatTrace(parseTrace(transcript));
    expect(out).toContain("YOU   check the auth tests");
    expect(out).toContain("↳ exec(pnpm test src/auth) [ERROR 3.0s] → FAIL rejects expired token");
    expect(out).toContain("↳ read(src/auth/session.ts) [ok 0.2s]");
    expect(out).toContain("FRIDAY One auth test fails");
  });
});
