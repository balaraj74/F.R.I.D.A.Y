---
summary: "CLI reference for `friday config` (get/set/unset config values)"
read_when:
  - You want to read or edit config non-interactively
---

# `friday config`

Config helpers: get/set/unset values by path. Run without a subcommand to open
the configure wizard (same as `friday configure`).

## Examples

```bash
friday config get browser.executablePath
friday config set browser.executablePath "/usr/bin/google-chrome"
friday config set agents.defaults.heartbeat.every "2h"
friday config set agents.list[0].tools.exec.node "node-id-or-name"
friday config unset tools.web.search.apiKey
```

## Paths

Paths use dot or bracket notation:

```bash
friday config get agents.defaults.workspace
friday config get agents.list[0].id
```

Use the agent list index to target a specific agent:

```bash
friday config get agents.list
friday config set agents.list[1].tools.exec.node "node-id-or-name"
```

## Values

Values are parsed as JSON5 when possible; otherwise they are treated as strings.
Use `--json` to require JSON5 parsing.

```bash
friday config set agents.defaults.heartbeat.every "0m"
friday config set gateway.port 19001 --json
friday config set channels.whatsapp.groups '["*"]' --json
```

Restart the gateway after edits.
