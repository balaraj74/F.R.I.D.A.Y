import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let server: http.Server;
let home: string;
const seen: Array<{ url?: string; key?: string; body: string }> = [];

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "n8n-"));
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, key: req.headers["x-n8n-api-key"] as string | undefined, body });
      res.setHeader("content-type", "application/json");
      if (req.url?.startsWith("/api/v1/workflows")) {
        res.end(
          JSON.stringify({
            data: [
              {
                id: "1",
                name: "Professor mail",
                active: true,
                nodes: [{ type: "n8n-nodes-base.webhook", parameters: { path: "prof-mail" } }],
              },
            ],
          }),
        );
      } else if (req.url === "/webhook/prof-mail") {
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.statusCode = 404;
        res.end('{"message":"webhook not registered"}');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  vi.stubEnv("FRIDAY_N8N_URL", `http://127.0.0.1:${(server.address() as { port: number }).port}`);
  vi.stubEnv("HOME", home);
});
afterAll(() => {
  server.close();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

const tool = async () => (await import("./automations-tool.js")).createAutomationsTool();
const text = (r: unknown) =>
  JSON.parse((r as { content: Array<{ text: string }> }).content[0].text);

describe("automations tool", () => {
  it("triggers a workflow by its webhook with JSON data", async () => {
    const t = await tool();
    expect(
      text(
        await t.execute("1", {
          action: "trigger",
          path: "/prof-mail",
          data: '{"subject":"Lab 4"}',
        }),
      ),
    ).toEqual({
      triggered: "prof-mail",
      result: { ok: true },
    });
    expect(seen.at(-1)).toMatchObject({ url: "/webhook/prof-mail", body: '{"subject":"Lab 4"}' });
    await expect(t.execute("2", { action: "trigger", path: "missing" })).rejects.toThrow(/404/);
    await expect(t.execute("3", { action: "trigger", path: "../etc" })).rejects.toThrow(
      /may only contain/,
    );
  });

  it("lists workflows only with Sir's API key, and explains how to get one", async () => {
    const t = await tool();
    expect(text(await t.execute("1", { action: "list" })).note).toMatch(/Settings → n8n API/);
    fs.mkdirSync(path.join(home, ".friday"), { recursive: true });
    fs.writeFileSync(path.join(home, ".friday", "n8n-api-key"), "test-key\n");
    expect(text(await t.execute("2", { action: "list" })).workflows).toEqual([
      { id: "1", name: "Professor mail", active: true, webhooks: ["prof-mail"] },
    ]);
    expect(seen.at(-1)?.key).toBe("test-key");
  });
});
