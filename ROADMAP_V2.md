# FRIDAY v2 Roadmap

Decided 2026-10-22 with Sir:
- **Order:** HUD (F) → Memory (C) → Autonomy (D) → Tool harness + Personality (B+E). Foundation (A) first, kept small.
- **Brain:** stays on `antigravity-proxy` (unofficial; the fallback chain in `~/.friday/friday.json` is the reliability layer).
- **Autonomy:** mostly autonomous. Acts without asking, reports after — except the hard-never list below.
- **Interfaces:** Desktop HUD (voice + typing) and WhatsApp.

Honesty rule (from `friday_upgrade_master_prompt.md`): every "mind-like" feature must be a mechanism that changes behaviour and can be measured. FRIDAY may describe her computed state; she does not claim sentience or AGI.

---

## Milestone A — Foundation (small, first)

| # | Work | Done when |
|---|---|---|
| A1 | Re-run `eval_runner.py` **live** (not `--dry-run`) on the current branch | A live report exists; Phases 2–7 are re-verified or their regressions listed |
| A2 | Grow `eval_tasks.jsonl` from 61 to ~150 harder tasks (separate, human-approved commit per the plan's rule 5) | Live baseline is meaningfully below 100% |
| A3 | Write `AUTONOMY_POLICY.md` and enforce it in code (tool risk tiers), replacing the "FULL CLEARANCE / don't ask" prompt wording | Refusal category stays at 100% live |
| A4 | Provider health: detect proxy failures, fall through the fallback chain, surface "brain degraded" in the HUD | Killing the proxy mid-turn falls back without a crash |

**Hard-never list (needs Sir every time, even in autonomous mode):** deleting data or files outside FRIDAY's scratch dirs, any payment or money movement, entering or sharing credentials, sending messages to new recipients, changing system or security settings, git force-push.

## Milestone F — HUD: animation and interaction

Builds on the existing `friday-hud` (React + three.js + Electron): `ArcReactorCore`, `ReasoningActionTrace`, `ApprovalsPanel`, `speech.ts`, `gateway-ws.ts`.

| # | Work |
|---|---|
| F1 | **One state machine** for FRIDAY's presence: `idle → listening → thinking → acting → speaking → idle` (+ `degraded`, `awaiting-approval`), driven only by real events (`agent`, `chat`, `exec.approval.requested`, mic VAD, TTS playback). Removes the manual mode override as the default path. |
| F2 | **Reactive core** at 60 fps on Intel iGPU: mic amplitude drives the core while listening, TTS amplitude while speaking, a pulse per tool call while acting, affect vector (valence/arousal/caution) drives hue, turbulence and speed. Single `requestAnimationFrame` loop, shader-based, no React re-render per frame. Respects reduced-motion. |
| F3 | **Voice loop**: push-to-talk + wake word, streaming transcript, **barge-in** (talking over FRIDAY stops TTS and cancels the turn), spoken replies with text in sync. |
| F4 | **Tool cards**: each tool call appears live (name, args summary, duration, result/error), groups parallel calls, expandable; approvals render inline on the card and on WhatsApp. |
| F5 | **Thought stream** panel: FRIDAY's plan steps and reflections as they happen (the real plan/reflect output, not decoration). |
| F6 | Perf budget check: < 8 ms/frame on the iGPU, HUD idle CPU < 3%. |

**Status 2026-10-22:** F1 + F2 implemented in `friday-hud` (`services/presence.ts`, `components/ReactorCanvas.tsx`, rewired `ArcReactorCore`, `speech.ts`, `gateway-ws.ts`, `App.tsx`). Verified in the dev browser: all six states render and blend; 7.0 ms/frame (144 fps) idle and in approval state. `tsc` + `vite build` pass. Not yet verified: real mic/TTS levels inside Electron (needs `edge-tts` installed) and live gateway events. Also fixed: shell injection in all `electron/main.cjs` `exec` calls (now `execFile` argument vectors), duplicate sidebar entry, fabricated greeting facts.
Open: Header shows hard-coded "26°C Partly Cloudy" and "SONNET 5".

**Status 2026-10-22 (F3 voice loop):** implemented. Offline Vosk wake word ("Friday"/"Hey Friday") + live transcript sidecar (`friday-hud/voice/friday_wake.py`, setup via `voice/setup.sh`, model in `~/.friday/models`); Ctrl+Alt+Space push-to-talk via GNOME custom shortcut → `voice/ptt.sh` → private Unix socket (`electron/voice-control.cjs`); barge-in (echo-cancelled mic while speaking, 320 ms sustained voice) stops speech and aborts the run; sentence-streamed TTS (`services/speech-text.ts`) starts at the first sentence, skips code blocks and the sign-off, and stays quiet after an interrupt; one controller (`services/voice-loop.ts`). Gemini STT key and gateway token removed from source (key: `GEMINI_API_KEY` or `~/.friday/credentials/gemini_api_key`; without it, the offline transcript is used). Verified: text rules (6/6 checks), sidecar lifecycle (mic released 67 ms after quit), socket PTT delivery, queue/interrupt behaviour in the dev browser, `tsc` + `vite build`. Not verified: real mic, wake accuracy and barge-in echo behaviour inside Electron on the laptop (needs Sir to try it).
**Secrets:** the Gemini key and gateway token are still in local commit `9f9361cb5` (not pushed). Rotate both before pushing any branch containing it.

## Milestone C — Memory that remembers everything

| # | Work |
|---|---|
| C1 | **Episodic log**: every turn (all channels) stored with timestamp, channel, affect vector, tools used — already partly in session `.jsonl`; unify and index into the existing sqlite-vec hybrid store. |
| C2 | **Knowledge graph**: entities (people, projects, courses, deadlines) and relations extracted by the consolidation job; contradictions flagged, not overwritten (Phase 4 rule). |
| C3 | **Recall scoring** = relevance × recency decay × importance (+ affect boost from Phase 2), bounded token budget per turn. |
| C4 | Commands: "what do you know about X", "when did we talk about Y", "forget Z" (real deletion + tombstone). |
| C5 | Evals: `memory_recall` tasks spanning days/weeks, including contradiction and forget cases. |

## Milestone D — Autonomy and decisions

| # | Work |
|---|---|
| D1 | **Agenda loop**: background scheduler over `~/.friday/agenda.json` goals; picks next action by priority × deadline × feasibility. |
| D2 | **Monitors**: deadlines (calendar/memory), git repos (failing builds, stale branches), system health, WhatsApp follow-ups. |
| D3 | **Decision policy** from A3: act → log → report after; hard-never list → ask. Budgets: max actions/hour, max tokens/day. |
| D4 | Morning brief + evening summary on WhatsApp; "what did you do today" answered from the action log. |
| D5 | Kill switch: one command / HUD button pauses all autonomous activity. |

## Milestone B+E — Tool harness and personality

| # | Work |
|---|---|
| B1 | Typed tool registry: JSON schema, risk tier, timeout, retries with backoff, idempotency flag. |
| B2 | Parallel independent calls; result summarisation for long outputs; per-turn tool budget from affect (Phase 2). |
| B3 | Replayable trace of every turn (feeds HUD F4 and evals). |
| E1 | Self-model file (bounded): current goals, recent lessons, preferences learned — loaded every turn. |
| E2 | Persona consistency evals (tone, address as Sir/Boss, sign-off rules) so personality survives model fallbacks. |
| E3 | Affect visibly shapes tone and choices (and is shown in the HUD), verified by the Phase 2 deletion test. |

---

## Process (unchanged from the master prompt)
Each milestone item: implement → `pnpm build` + `pnpm test` + live eval → report → Sir confirms → next. No item is "done" on a dry-run eval.

**Status 2026-10-22 (F4 + F5 + honesty fixes):**
- F4 tool cards + F5 thought stream: `friday-hud/src/components/LiveActivity.tsx` (+ `services/activity-format.ts`) under the reactor: live tool cards (key arg, timer, result/error, parallel calls grouped, expandable), inline Allow/Deny approvals (cleared when resolved anywhere), reasoning tail, and real reflection events. Backend now emits `stream: "reflection"` (`recall` lessons before a run, `lesson` after) from `src/agents/pi-embedded-runner/run/attempt.ts` (additive; Sir's uncommitted lines untouched). Fixed: runs ending left tools "running" (no listener notify on lifecycle end).
- Fixed fake data: header model badge now reads `agents.defaults.model.primary`; weather is live (Open-Meteo, hidden if unavailable); Evolution badge/panel show "—" instead of invented numbers; duplicate tagline removed.
- Camera button takes a webcam photo; paperclip attaches images (≤5 MB, sent as real `chat.send` attachments) or text/code files (≤100 KB, inlined).
- `antigravity-claude-proxy` pinned to 2.8.7 in `main.cjs`, `start.sh`, `setup.sh`.
- Verified: helper checks (6/6), live strip with simulated gateway events (render, Allow, lifecycle end → idle, lesson, fade-out), `tsc` (HUD + root), `vite build`, reflection/agent-event tests pass. `src/agents/affect/affect.test.ts` "restricts tool call budget under high caution" FAILS because of Sir's uncommitted `wiring.ts` change (budget floor 50) — not touched; needs a decision.

**Status 2026-10-22 (C1 memory recall):**
- Found: the memory index was empty since 2026-10-03 (no embedding provider configured) and the Phase 4 consolidation job was never scheduled.
- Now: local EmbeddingGemma-300M (`~/.friday/models/`, offline) indexes MEMORY.md, memory/*.md and all 128 session transcripts (all channels): 135 files, 200-token chunks, hybrid vector+keyword, auto-sync (watch, on session start, on search, every 30 min). Config in `~/.friday/friday.json` (backup: `~/desktop-backup/friday.json.before-memory`).
- Fixed in `src/memory/embeddings.ts`: concurrent first use downloaded/loaded the model several times (rename race); inputs longer than the model window crashed indexing (now truncated by real token count); EmbeddingGemma task prompts added (query vs document). Type stub `src/types/node-llama-cpp.d.ts` extended. 3 new tests.
- Benchmark (paraphrased questions, top-2): hackathon prizes ✓, Cinetra deck ✓, DBMS lab ✓, phone number ✓(2nd); nonsense query scores 0.23 → minScore 0.27. MiniLM tried first: too little separation (0.31 real vs 0.28 noise).
- Verified: 60/60 memory tests, root `tsc`.
- Next: C2 consolidation → reviewable proposals (it currently writes MEMORY.md directly, against Phase 4's rule) + nightly schedule; C3 recency/importance ranking; C4 "what do you know about X" / "forget X"; C5 memory evals.

**Status 2026-10-22 (C2–C5 memory):**
- C2: consolidation gained review mode (`proposalsDir`): writes `~/.friday/memory/proposals/<date>/REVIEW.md` + proposed files; `friday memory consolidate [--hours N] [--apply <date>]`; apply refuses if MEMORY.md/USER.md changed since. Gateway runs it nightly at 03:30 (`startMemoryConsolidationSchedule`). Real run over 30 days: 27 sessions, nothing proposed — the Phase 4 regex extractor only catches fixed phrasings ("Please remember that…"). Follow-up: LLM-based extraction.
- C3: `src/memory/rerank.ts` — relevance threshold first, then recency (30-day half-life) and importance (MEMORY/USER.md > memory notes > transcripts). Results carry `updatedAt` / tool `when` date. Found: Phase 2 "arousal-boosted retrieval" (`getArousal`) is never passed by the manager — not wired.
- C4: `memory_forget` tool + `friday memory forget "<phrase>"` (tombstones in `~/.friday/memory/forgotten.json`, index purge, curated-line removal, skipped on reindex/search); prompt guidance for "what do you know / when did we / forget". Verified end-to-end with a throwaway note.
- C5: 8 transcript-grounded memory tasks proposed in `eval_tasks.memory.proposed.jsonl` (not merged into eval_tasks.jsonl per plan rule 5 — needs Sir's explicit OK and its own commit).
- Verified: 122 tests across memory/prompt/policy/CLI/plugins pass; root `tsc` clean.

**Status 2026-10-22 (A3 + D autonomy):**
- A3 enforced policy: `src/infra/autonomy-policy.ts` classifies shell commands; hard-never categories (delete-data, force-push, system-settings, credentials, money, remote-code) always go to approval — also under security=full, ask=off, elevated=full — on timeout they are denied, and "allow always" is never remembered. FOUND + FIXED: with the default `host: "sandbox"` and no sandbox configured, exec ran directly on the machine with NO approval checks at all; policy hits are now routed through the gateway approval path. (Found because a test really executed `git push --force origin main`; it failed on missing credentials, remote main verified unchanged at 4c089d37c.) 44 policy cases + 3 enforcement tests.
- Config (backup `~/desktop-backup/friday.json.before-autonomy`): `tools.exec = {security: full, ask: off}` (Sir chose mostly autonomous); approvals forwarded to WhatsApp + HUD; heartbeat every 30m, 08:00–23:30 IST, delivering to Sir's WhatsApp.
- D1/D2: `~/friday/HEARTBEAT.md` operating loop (backup in desktop-backup) + `friday autonomy situation` (agenda due/overdue, open memory tags, unpushed/behind repos, uncommitted summary, disk/RAM/battery, memory proposals) — deterministic, ~7s, no model call.
- D3: may-do / never-on-own lists in HEARTBEAT.md; ≤5 tool calls per heartbeat; action log in memory/<today>.md.
- D4: briefings fixed — they were failing (pinned to ollama models) and scheduled at UTC-looking times in IST, and wakeMode next-heartbeat never fired without a heartbeat. Now 08:00 / 21:00 (includes today's autonomous actions) / 23:30 IST. system-stats-monitor + timely-greetings disabled (covered by the loop without per-hour model calls). Cron backup: `~/desktop-backup/cron-jobs.before-autonomy.json`.
- D5: kill switch `friday autonomy pause|resume|status` + HUD header button (same `~/.friday/autonomy.json`); heartbeat and scheduled jobs skip while paused, manual `cron run` still works.
- Needs gateway restart to load the new code (dist rebuilds on start).

**Status 2026-10-22 (B+E — final milestone):**
- B1 `src/agents/tool-traits.ts`: per-tool traits (risk read|act, idempotent, timeout, retries). Applied to every tool in `pi-tools.ts`.
- B2: read-only tools get a 90 s timeout and up to 2 retries with exponential backoff on transient errors only; side-effecting tools (exec, write, message, memory_forget…) are never retried. All tool results capped at 60k chars (head+tail kept). Parallel: `patches/@mariozechner__pi-agent-core@0.49.3.patch` (pnpm patchedDependencies) runs consecutive `parallelSafe` (read-only) calls concurrently; everything else stays sequential; result order preserved. Verified by `src/agents/tool-parallel.test.ts` against the real agent loop.
- B3: `friday trace [session] [--last N] [--json]` (`src/sessions/trace.ts`) replays turns from existing transcripts: messages, tool calls + key arg, ok/ERROR, duration, first result line.
- E1: Phase 6 self-model verified bounded (50 lessons max, compaction at 60); top-3 relevant lessons retrieved per turn (existing).
- E2: 6 persona tasks proposed in `eval_tasks.persona.proposed.jsonl` (needs Sir's OK per rule 5). Note: persona-03 will fail today because IDENTITY.md/SOUL.md say "Claude Opus 5" while the runtime model is Gemini via the proxy.
- E3: runner emits `stream: "affect"` each run; HUD shows mood words with exact values in a tooltip, and the reactor is modulated (arousal → speed, curiosity → shimmer, caution → amber, valence → brightness) without overriding state colours.
- Verified: 331 tests across tools/runner/exec/autonomy/memory/trace pass; root `tsc` clean; HUD `tsc` + build; affect readout checked live in the dev browser.
- Proxy (antigravity) unchanged by request; nothing is pushed.

**Branding 2026-10-22:** FRIDAY identifies only as "FRIDAY v2026.1.27 (beta), running on ARIA". Persona files (~/friday + repo copies of SOUL.md / IDENTITY.md; backups in ~/desktop-backup/*.before-branding) instruct her never to name the underlying model/vendor/proxy and never to claim another named model. HUD badge shows the repo version (`v2026.1.27 β`); Electron no longer sends the model name to the UI; skills panel no longer shows the vendor path. persona-03 eval updated to match.

**Status 2026-10-22 (HUD honesty + consistency audit, code done, visual pass pending):**
- Removed fake/hard-coded data: Config panel (model name, token counts 60,422/200,000, workspace path, "Token Verified"), Chat headers ("Claude Sonnet 5"), startup boot log (staged lines → real steps: start gateway, connect, ready), Channels (WhatsApp always "ONLINE & LINKED", number/JID/"428 OK" → real gateway status, dashes when unknown), Skills count fallback, canned chat greeting, Agenda default schedule, Active Project + Projects modal (invented progress/hackathon list → real git repos with last commit/branch/uncommitted/unpushed via Electron `projects:list`), system stats (invented 22/56/64/18/88 fallbacks → null shown as "—"; RAM now uses MemAvailable like `free`; disk uses available space), "All Systems Online" → derived Nominal/Attention/Partial, Evolution claims ("Sub-50ms", "Zero Fault Leakage", "100% Rollback-Safe", model name) → factual text.
- Logs: raw JSON → time, level, [subsystem], message; ERROR/WARN/INFO/DEBUG toggles; click row for details. Heartbeat prompts in chat history → slim "Autonomy check" dividers.
- Fonts self-hosted (public/fonts + src/fonts.css, latin subset, ~122 KB); Google Fonts link and duplicate <title> removed.
- Verified: HUD `tsc` + `vite build`. NOT verified: any of the above visually (dev server launch was denied this turn). Layout/alignment of every tab still needs an on-screen pass.

## MCP connections (2026-10-22) — DONE
- Native multi-server MCP client in the gateway (`src/agents/mcp/manager.ts`, official `@modelcontextprotocol/sdk`).
  Local (stdio) and remote (Streamable HTTP / SSE) servers; tools exposed as `mcp_<server>_<tool>`.
- Config `mcp.servers.<name>` {command,args,env,cwd | url,transport,headers; allow, deny, readOnly, timeoutMs, enabled}; `${ENV}` placeholders kept unexpanded on CLI writes.
- Long-lived connections, reconnect with backoff (5s→5min), tools/list_changed refresh, follows config edits without restart; one broken server never affects others.
- MCP tools default to "act" traits (no retry/parallel); `readOnly` opts in.
- Gateway RPC `mcp.status` (read) / `mcp.reconnect` (admin); CLI `friday mcp list|add|remove|enable|disable|reconnect|test`.
- Verified: 6 unit/integration tests (two stdio servers at once); live agent turn called two MCP tools.

## Two brains, commitments, earned trust (2026-10-22) — DONE
- **Fast brain** (`src/agents/fast-brain.ts`, config `agents.defaults.fastModel`, default proxy `gemini-3.5-flash-lite`):
  gateway `brain.ack` returns a one-line acknowledgement (SKIP for small talk; truncated/model-naming replies dropped).
  HUD asks speculatively on the partial transcript while Sir speaks (`friday-hud/src/services/fast-brain.ts`), speaks it
  as the first line of the turn and shows it as the WorkingCard headline; "On it." only if the ack is late.
  Measured: ~2.5–3.5 s warm (7.6 s cold) — no sub-second model reachable via the proxy; a local GGUF model is the next step.
- **Commitments** (`src/agents/commitments/`): gateway scans new transcript lines every 20 min (HUD + WhatsApp self-chat;
  eval/test/cron sessions skipped), fast-brain extraction → `~/.friday/commitments/commitments.json`. Overdue / next-3h /
  today items appear in the situation report; `commitments` agent tool; `friday commitments list|add|done|dismiss|scan`.
  WhatsApp is self-chat only, so chats with other people are NOT read (Sir's decision to change).
- **Earned trust** (`src/infra/autonomy-trust.ts`, `src/agents/tool-trust.ts`): per action-kind track record; in
  autonomous runs (heartbeat/cron) a kind runs without asking after 5 clean runs in a row, otherwise exec goes to approval
  and file writes outside ~/friday are refused. Never auto: git push, publish, GitHub writes, network sends, messaging
  anyone but Sir. File writes are snapshotted (`friday trust undo <id>`); undo hints for git commit/systemctl/pip/npm/mkdir/mv.
  Morning brief via situation report; `friday trust status|grant|revoke|log|brief|undo`.
- Verified: 31 new tests; live brain.ack, live extraction (resolved "Friday" correctly), live autonomous write refused.

## Open-source upgrade wave (2026-10-28) — DONE
- **Browser hands** — Microsoft Playwright MCP (`~/.friday/mcp/playwright`, headless Chromium, own profile
  `~/.friday/browser-profile`). 25 tools as `mcp_browser_*` (duplicate server prefix now stripped). Reading tools are
  read-only; clicking/typing/submitting is NEVER autonomous (`mcp:browser` never-auto). Live: read HN top stories.
- **Local voice** (`friday-hud/electron/local-voice.cjs`, `friday-hud/voice/voice-server.mjs`, `voice/setup-local.sh`):
  whisper.cpp server (small.en + Silero trim, port 18950, per-clip audio_ctx → ~0.6–1.3 s), Kokoro-82M fp32 TTS
  (~0.3× real time, offline; edge-tts fallback; `~/.friday/voice.json` {engine, kokoroVoice}), Silero VAD streamed over
  WS (port 18951) for end-of-speech and stricter barge-in. Whisper "heard nothing" no longer falls back to Vosk guesses.
- **Agent swarm** (`swarm` tool): 2–8 specialists in parallel on the subagent lane, optional reviewer cross-check,
  scratch sessions deleted; swarms can't nest. Children of autonomous runs get `subagent:auto-` keys so earned-trust
  gates still apply (also for sessions_spawn). Live: 2-agent research in 105 s.
- **Knowledge graph** (`src/agents/knowledge/`): SQLite entities + temporal facts (single-valued relations superseded,
  history kept), fed by the 20-min scan; `knowledge` tool; who-is-who injected into the system prompt for mentioned
  entities; `friday knowledge list|show|search|forget`.
- **Code sandbox** (`run_code` tool, `src/agents/sandbox-exec/bwrap.ts`): bubblewrap, no home access, no network unless
  asked, CPU/file/process caps, scratch dirs pruned after 3 days.
- Ops finding: proxy (port 8080) and gateway do not auto-start after reboot; systemd user units need Sir's OK.

## App-controlled lifecycle (2026-10-28) — DONE
- Nothing starts at login or when the window opens. INITIALIZE runs real steps (`boot:step`): reasoning engine
  (tmux friday-proxy, waits until it answers, ≤2 min) → gateway (tmux friday, only if not running) → voice models
  (loading in parallel from the start) → HUD connect → tools (mcp.status) → ready. Cold start measured: 12.2 s.
- Closing the app shuts FRIDAY down completely (before-quit): voice stack, gateway (SIGTERM → graceful: WhatsApp,
  heartbeat, reminders, scans, MCP browser), reasoning engine; SIGKILL fallback; hard exit after 15 s.
  Measured: all processes gone ~1 s after close, gateway logged a graceful SIGTERM shutdown.
