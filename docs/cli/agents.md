---
summary: "CLI reference for `friday agents` (list/add/delete/set identity)"
read_when:
  - You want multiple isolated agents (workspaces + routing + auth)
---

# `friday agents`

Manage isolated agents (workspaces + auth + routing).

Related:
- Multi-agent routing: [Multi-Agent Routing](/concepts/multi-agent)
- Agent workspace: [Agent workspace](/concepts/agent-workspace)

## Examples

```bash
friday agents list
friday agents add work --workspace ~/friday-work
friday agents set-identity --workspace ~/friday --from-identity
friday agents set-identity --agent main --avatar avatars/friday.png
friday agents delete work
```

## Identity files

Each agent workspace can include an `IDENTITY.md` at the workspace root:
- Example path: `~/friday/IDENTITY.md`
- `set-identity --from-identity` reads from the workspace root (or an explicit `--identity-file`)

Avatar paths resolve relative to the workspace root.

## Set identity

`set-identity` writes fields into `agents.list[].identity`:
- `name`
- `theme`
- `emoji`
- `avatar` (workspace-relative path, http(s) URL, or data URI)

Load from `IDENTITY.md`:

```bash
friday agents set-identity --workspace ~/friday --from-identity
```

Override fields explicitly:

```bash
friday agents set-identity --agent main --name "Clawd" --emoji "🤖" --avatar avatars/friday.png
```

Config sample:

```json5
{
  agents: {
    list: [
      {
        id: "main",
        identity: {
          name: "Clawd",
          theme: "space lobster",
          emoji: "🤖",
          avatar: "avatars/friday.png"
        }
      }
    ]
  }
}
```
