import { describe, expect, it } from "vitest";

import { createGeminiSignatureExtension, prepareGeminiPayload } from "./gemini-signatures.js";

const payload = () => ({
  model: "gemini-4-hydrogen-sonar",
  messages: [
    { role: "user", content: [{ type: "text", text: "fix the file" }] },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "old", name: "edit", input: { path: "a.ts" } }],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "old", content: [{ type: "text", text: "ok" }] },
      ],
    },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "known", name: "read", input: { path: "b.ts" } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "known", content: "file text" }],
    },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "current", name: "exec", input: { command: "ls" } }],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "current", content: "x" }] },
  ],
});

describe("prepareGeminiPayload", () => {
  it("restores known signatures, flattens unknown history, keeps the current turn native", () => {
    const sigs: Record<string, string> = { known: "SIG-KNOWN" };
    const { payload: out, restored, flattened } = prepareGeminiPayload(payload(), (id) => sigs[id]);
    const msgs = (out as ReturnType<typeof payload>).messages as Array<{
      content: Array<Record<string, unknown>>;
    }>;
    expect(restored).toBe(1);
    expect(flattened).toBe(1);
    expect(msgs[1].content[0]).toEqual({ type: "text", text: '[I called edit {"path":"a.ts"}]' });
    expect(msgs[2].content[0]).toEqual({ type: "text", text: "[edit returned: ok]" });
    expect(msgs[3].content[0].thoughtSignature).toBe("SIG-KNOWN");
    expect(msgs[4].content[0].type).toBe("tool_result");
    expect(msgs[5].content[0]).toMatchObject({ type: "tool_use", id: "current" });
    expect(msgs[6].content[0].type).toBe("tool_result");
  });

  it("leaves payloads without messages alone", () => {
    expect(prepareGeminiPayload({ foo: 1 }, () => undefined).flattened).toBe(0);
  });
});

describe("createGeminiSignatureExtension", () => {
  it("only applies to Gemini models on the anthropic-messages API", () => {
    expect(
      createGeminiSignatureExtension({
        modelId: "gemini-4-hydrogen-sonar",
        api: "anthropic-messages",
      }),
    ).toBeDefined();
    expect(
      createGeminiSignatureExtension({
        modelId: "claude-opus-4-6-thinking",
        api: "anthropic-messages",
      }),
    ).toBeUndefined();
    expect(
      createGeminiSignatureExtension({ modelId: "gemini-3-flash", api: "google-generative-ai" }),
    ).toBeUndefined();
  });
});
