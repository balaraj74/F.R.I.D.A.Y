// Minimal stdio MCP server for tests: `echo` and `add` tools; label comes from argv[2].
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const label = process.argv[2] ?? "echo";
const server = new McpServer({ name: `test-${label}`, version: "1.0.0" });
server.tool("echo", "Echo text back", { text: z.string() }, async ({ text }) => ({
  content: [{ type: "text", text: `${label}:${text}` }],
}));
server.tool("add", "Add two numbers", { a: z.number(), b: z.number() }, async ({ a, b }) => ({
  content: [{ type: "text", text: String(a + b) }],
}));
server.tool("fail", "Always fails", {}, async () => ({
  isError: true,
  content: [{ type: "text", text: "boom" }],
}));
await server.connect(new StdioServerTransport());
