---
summary: "How the durable job engine works: event log, steps, leases, verifier, budgets and approvals"
read_when:
  - You want to run long, multi-step work that survives restarts
  - You need to understand why a Job paused, failed or is waiting for approval
---
# Job engine

The job engine runs long work as a **Job**. A Job is a goal that the engine splits into Tasks, runs as Steps, checks, and records. Jobs can run for days, and they survive a Gateway restart.

Manage Jobs with [`friday jobs`](/cli/jobs).

## Event log

All Job state comes from an append-only event log stored in SQLite. Nothing edits an event after it is written. On boot the engine replays the log to rebuild each Job.

- A truncated or unreadable final event is ignored, and a warning records the discarded event.
- `friday jobs replay <id>` prints every event of a Job in time order.

Job states are `pending`, `running`, `waiting_approval`, `verifying`, `done`, `failed` and `cancelled`.

## Tasks and steps

The planner turns a goal into a graph of Tasks with dependencies and acceptance checks. Each Task has a role: `researcher`, `builder`, `operator`, `reviewer` or `verifier`. Each role has its own tool allowlist.

A Task runs as one or more **Steps**. A Step is a fresh-context agent turn. It receives a small `progress.md` file instead of the full history, so long Jobs do not grow the context.

If a Step fails on its model, the runner retries it on the next model in the fallback list. When the list is exhausted, the Step fails with a reason stating that all models failed. The default Step timeout is 600 seconds, and a configured value must be an integer from 1 to 86400.

## Leases

A worker holds a **lease** on each running Step. A lease lasts 30 seconds and each heartbeat extends it by another 30 seconds. A heartbeat for an expired or reclaimed lease is rejected.

When the Gateway boots, it finds running Steps whose lease expired, records a lease-reclaimed event for each, and resumes them.

## Verifier

A separate verifier agent checks each Task against its acceptance checks: tests pass, file exists, exit code, or a rubric. The verifier records evidence for each check. A Task is marked `done` only when every check is confirmed and has evidence.

## Budgets

Every Step and every Job has a budget with limits for tokens, wall-clock seconds and tool calls. When a limit is reached, the engine stops the Step within 5 seconds and marks it failed. The `progress.md` file stays as last written, and a budget-exceeded event names the limit that was hit.

A loop detector flags repeated identical tool calls and near-identical plans before they use up the budget.

## Never-auto approvals

Some actions are never done automatically. Examples are pushing code, publishing a package, writing to GitHub, messaging other people, controlling the screen, and changing your own branches. The full list is `NEVER_AUTO` in `src/infra/autonomy-trust.ts`.

When a Task attempts one of these actions:

- The engine withholds the action.
- Only that Task moves to `waiting_approval`. Other Tasks are not changed.
- You are notified through the HUD and WhatsApp, with reminders at the configured interval (1 minute to 24 hours, default 15 minutes).
- The action runs only after you approve it. Earlier approvals, a streak of successes and trust grants do not change this.

If you cancel the Job, the pending approval is discarded, the Task is cancelled, and the withheld action is not performed. Every `git push` needs approval.

## Health monitor

The health monitor checks the local model proxy, free disk space and internet reachability.

- A failed proxy check starts a restart. After three failed restarts in a row it stops retrying and notifies you.
- Below the disk threshold, new Jobs are refused. Running Jobs are not touched.
- After 10 seconds without a network, Steps that need the network pause. They resume when the network returns.

Run `friday jobs health` to check that the monitor loads and can probe. It needs no Gateway.

## Installer checks

On a fresh install, `install.sh` runs `friday jobs --help`, `friday design --help` and `friday jobs health`. It reports success only when all three work. If one fails, it exits with a non-zero status and names the failed component.

To start FRIDAY automatically, pass `--autostart`. On Linux this writes a systemd user unit to `~/.config/systemd/user/friday.service` and enables it. If registration fails, the installer prints an error and exits with a non-zero status. Without the flag, nothing is registered.

## Platform support

The job engine, the installer and the auto-start registration target Linux. Windows support is an open question and is not decided.

Related:

- [`friday jobs`](/cli/jobs)
- [Design workflow](/cli/design)
