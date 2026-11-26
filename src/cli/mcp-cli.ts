import type { Command } from "commander";

import { mcpManager, type McpServerStatus } from "../agents/mcp/manager.js";
import { loadConfig, readConfigFileSnapshot, writeConfigFile } from "../config/config.js";
import type { FRIDAYConfig } from "../config/config.js";
import type { McpServerConfig } from "../config/types.mcp.js";
import { defaultRuntime } from "../runtime.js";
import { callGatewayFromCli } from "./gateway-rpc.js";

const NAME_RE = /^[a-zA-Z0-9_-]{1,32}$/;

const collect = (value: string, prev: string[] = []) => [...prev, value];

function parsePairs(
  pairs: string[] | undefined,
  label: string,
): Record<string, string> | undefined {
  if (!pairs?.length) return undefined;
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const i = pair.indexOf("=");
    if (i <= 0) throw new Error(`${label} must look like KEY=VALUE (got "${pair}")`);
    out[pair.slice(0, i).trim()] = pair.slice(i + 1);
  }
  return out;
}

/** Edit the raw config file (keeps ${ENV_VAR} placeholders unexpanded). */
async function editServers(edit: (servers: Record<string, McpServerConfig>) => void) {
  const snap = await readConfigFileSnapshot();
  if (snap.exists && !snap.valid) {
    throw new Error(`Config at ${snap.path} is invalid; fix it first (friday doctor).`);
  }
  const raw = (
    snap.exists && snap.parsed && typeof snap.parsed === "object" ? snap.parsed : {}
  ) as FRIDAYConfig;
  const next: FRIDAYConfig = { ...raw, mcp: { ...raw.mcp, servers: { ...raw.mcp?.servers } } };
  edit(next.mcp!.servers!);
  await writeConfigFile(next);
}

function formatStatus(servers: McpServerStatus[]): string {
  if (!servers.length)
    return "No MCP servers configured. Add one with: friday mcp add <name> -- <command> [args…]";
  const icon = { connected: "●", connecting: "◌", error: "✕", disabled: "○" } as const;
  return servers
    .map((s) => {
      const head = `${icon[s.state]} ${s.name}  [${s.kind}]  ${s.state}${s.serverInfo ? `  (${s.serverInfo.name} ${s.serverInfo.version})` : ""}`;
      const lines = [head];
      if (s.error) lines.push(`    error: ${s.error}`);
      if (s.tools.length) lines.push(`    ${s.tools.length} tools: ${s.tools.join(", ")}`);
      return lines.join("\n");
    })
    .join("\n");
}

async function gatewayStatus(): Promise<McpServerStatus[] | null> {
  try {
    const res = (await callGatewayFromCli(
      "mcp.status",
      { timeout: "15000" },
      {},
      { progress: false },
    )) as {
      servers: McpServerStatus[];
    };
    return res.servers;
  } catch {
    return null;
  }
}

export function registerMcpCli(program: Command) {
  const mcp = program
    .command("mcp")
    .description("Connect FRIDAY to MCP servers (their tools become her tools)");

  mcp
    .command("list")
    .alias("status")
    .description(
      "Show configured MCP servers, connection state and tools (from the running gateway)",
    )
    .option("--json", "Print JSON")
    .action(async (opts: { json?: boolean }) => {
      let servers = await gatewayStatus();
      let note = "";
      if (!servers) {
        note = "\n(gateway not reachable: showing a direct connection test from this machine)";
        await mcpManager.ensure(loadConfig(), 30_000);
        servers = mcpManager.status();
        await mcpManager.closeAll();
      }
      defaultRuntime.log(
        opts.json ? JSON.stringify({ servers }, null, 2) : `${formatStatus(servers)}${note}`,
      );
    });

  mcp
    .command("add <name> [command...]")
    .description(
      "Add a server. Local: friday mcp add files -- npx -y @modelcontextprotocol/server-filesystem ~/docs   Remote: friday mcp add notes --url https://host/mcp",
    )
    .option("--url <url>", "Remote server URL (instead of a command)")
    .option("--transport <kind>", "Remote transport: http (default) or sse")
    .option("--header <KEY=VALUE>", "HTTP header (repeatable; use ${ENV_VAR} for secrets)", collect)
    .option(
      "--env <KEY=VALUE>",
      "Environment for a local server (repeatable; use ${ENV_VAR} for secrets)",
      collect,
    )
    .option("--cwd <dir>", "Working directory for a local server")
    .option("--allow <tool>", "Only expose this tool (repeatable)", collect)
    .option("--deny <tool>", "Hide this tool (repeatable)", collect)
    .option(
      "--read-only <tool>",
      "Tool only reads, so it may be retried/parallelised (repeatable, * = all)",
      collect,
    )
    .option("--timeout <ms>", "Per-call timeout in ms")
    .option("--replace", "Overwrite an existing server with the same name")
    .action(
      async (
        name: string,
        command: string[],
        opts: {
          url?: string;
          transport?: string;
          header?: string[];
          env?: string[];
          cwd?: string;
          allow?: string[];
          deny?: string[];
          readOnly?: string[];
          timeout?: string;
          replace?: boolean;
        },
      ) => {
        if (!NAME_RE.test(name)) throw new Error("Server name: 1-32 letters, digits, _ or -");
        if (Boolean(opts.url) === Boolean(command?.length)) {
          throw new Error(
            "Give either a command (after --) for a local server, or --url for a remote one.",
          );
        }
        if (opts.transport && opts.transport !== "http" && opts.transport !== "sse") {
          throw new Error("--transport must be http or sse");
        }
        const entry: McpServerConfig = opts.url
          ? {
              url: opts.url,
              ...(opts.transport ? { transport: opts.transport as "http" | "sse" } : {}),
              ...(opts.header ? { headers: parsePairs(opts.header, "--header") } : {}),
            }
          : {
              command: command[0],
              ...(command.length > 1 ? { args: command.slice(1) } : {}),
              ...(opts.env ? { env: parsePairs(opts.env, "--env") } : {}),
              ...(opts.cwd ? { cwd: opts.cwd } : {}),
            };
        if (opts.allow) entry.allow = opts.allow;
        if (opts.deny) entry.deny = opts.deny;
        if (opts.readOnly) entry.readOnly = opts.readOnly;
        if (opts.timeout) entry.timeoutMs = Number(opts.timeout);
        await editServers((servers) => {
          if (servers[name] && !opts.replace)
            throw new Error(`"${name}" already exists (use --replace)`);
          servers[name] = entry;
        });
        defaultRuntime.log(`Added MCP server "${name}". Checking the connection…`);
        const servers = await gatewayStatus();
        const s = servers?.find((x) => x.name === name);
        defaultRuntime.log(
          s
            ? formatStatus([s])
            : "Gateway not reachable; it will connect when the gateway starts. Test now with: friday mcp test " +
                name,
        );
      },
    );

  mcp
    .command("remove <name>")
    .alias("rm")
    .description("Remove a server")
    .action(async (name: string) => {
      await editServers((servers) => {
        if (!servers[name]) throw new Error(`No MCP server named "${name}"`);
        delete servers[name];
      });
      defaultRuntime.log(`Removed MCP server "${name}".`);
    });

  for (const [cmd, enabled] of [
    ["enable", true],
    ["disable", false],
  ] as const) {
    mcp
      .command(`${cmd} <name>`)
      .description(`${enabled ? "Enable" : "Disable"} a server without removing it`)
      .action(async (name: string) => {
        await editServers((servers) => {
          if (!servers[name]) throw new Error(`No MCP server named "${name}"`);
          const { enabled: _old, ...rest } = servers[name];
          servers[name] = enabled ? rest : { ...rest, enabled: false };
        });
        defaultRuntime.log(`MCP server "${name}" ${enabled ? "enabled" : "disabled"}.`);
      });
  }

  mcp
    .command("reconnect [name]")
    .description("Reconnect one server (or all) in the running gateway")
    .action(async (name?: string) => {
      const res = (await callGatewayFromCli(
        "mcp.reconnect",
        { timeout: "60000" },
        name ? { name } : {},
      )) as {
        servers: McpServerStatus[];
      };
      defaultRuntime.log(formatStatus(res.servers.filter((s) => !name || s.name === name)));
    });

  mcp
    .command("test <name>")
    .description(
      "Connect to one server directly from this shell and list its tools (no gateway needed)",
    )
    .action(async (name: string) => {
      const cfg = loadConfig();
      const entry = cfg.mcp?.servers?.[name];
      if (!entry) throw new Error(`No MCP server named "${name}"`);
      await mcpManager.ensure(
        { mcp: { servers: { [name]: { ...entry, enabled: true } } } },
        60_000,
      );
      const status = mcpManager.status();
      await mcpManager.closeAll();
      defaultRuntime.log(formatStatus(status));
      if (status[0]?.state !== "connected") process.exitCode = 1;
    });
}
