---
summary: "CLI reference for `friday jobs` (create, list, show, pause, resume, cancel, replay, digest, health)"
read_when:
  - You want to create or control long-running Jobs from the terminal
  - You need to replay or summarise what a Job did
---
# `friday jobs`

Create and control Jobs. Background: [Job engine](/concepts/job-engine).

Every command except `health` calls the Gateway, so the Gateway must be running. If it does not answer within 10 seconds, the command prints an error and exits with code 1.

Common options for the Gateway commands:

- `--url <url>`: Gateway WebSocket URL.
- `--token <token>`: Gateway token, if required.
- `--json`: print JSON instead of text.

## create

Create a Job from a goal. `--type` is `coding`, `research` or `operations`.

```bash
friday jobs create "Summarise this week's release notes" --type research
```

## list

List Jobs, newest first. Use `--limit` for the page size and `--cursor` to continue from the cursor printed by the previous page.

```bash
friday jobs list --limit 10
```

## show

Show one Job with its Tasks and timeline.

```bash
friday jobs show <job-id>
```

## pause

Pause a running Job.

```bash
friday jobs pause <job-id>
```

## resume

Resume a paused Job.

```bash
friday jobs resume <job-id>
```

## cancel

Cancel a Job. Running Steps stop, their leases are released, and no further Steps start. A pending approval is discarded.

```bash
friday jobs cancel <job-id>
```

## replay

Print every event of a Job in ascending time order. Use it to see why a Job paused or failed.

```bash
friday jobs replay <job-id>
```

## digest

Summarise the Jobs that changed state. `--since` takes an epoch time in milliseconds.

```bash
friday jobs digest --since 1700000000000
```

## health

Check that the health monitor loads and can probe free disk space. This runs locally and needs no Gateway. The installer uses it.

```bash
friday jobs health
```
