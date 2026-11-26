---
name: human-deep-research
description: Run exhaustive, multi-round web research that plans, searches, cross-checks, changes course on surprises, and delivers a structured Word (.docx) or Markdown report with cited sources and honest uncertainty. Use this skill whenever the user asks for deep research, a thorough investigation, a literature or market review, a "find out everything about X" task, a comparison that needs verified facts, fact-checking of a contested claim, or any question where a single search would not give a trustworthy answer, even if they never say "deep research" or ask for a report.
homepage: https://github.com/balaraj74/friday
metadata: {"friday":{"emoji":"🔬","always":true,"requires":{"anyBins":["pandoc","python3"]}}}
---

# Human-Style Deep Research for FRIDAY

This skill makes FRIDAY research the way an elite human analyst does: frame the question, break it down, search in rounds, read real primary sources, notice surprises, chase leads, test emerging hypotheses against counter-evidence, and deliver an authoritative, structured report (`.docx` and `.md`).

## Core Depth & Standard

- Default to **exhaustive**: multiple search queries across iterative rounds, plus full-page content fetches (`web_fetch`) for primary sources, papers, technical filings, or statistics that carry real weight.
- Stop when new queries stop changing the conclusion or claim confidence levels.
- Never settle for shallow search snippets when full pages can be analyzed.

## Research Workflow

Keep a working notes file at `~/research/notes.md` (or `./research/notes.md`) throughout. It holds the active hypothesis plan, the claim ledger, and a running reflection log.

### Phase 1: Frame the Question
- Restate the core question in 1 to 2 sentences: what decision, strategic insight, or understanding does the user need?
- Define scope (time period, geography, technology stack, constraints) and state explicit assumptions.

### Phase 2: Decompose into Sub-Questions
- Break the central problem into 4 to 8 concrete sub-questions.
- Record an initial hypothesis for each, plus what counter-evidence would refute or change the hypothesis.

### Phase 3: Search in Iterative Rounds
Work in rounds, pausing briefly between rounds to reflect and update notes:
- **Round 1 (Landscape & Vocabulary):** Broad queries to discover industry terminology, main entities, official repositories, and the dominant consensus.
- **Round 2 (Targeted Verification):** Specific deep searches per sub-question using discovered vocabulary. Use `web_fetch` on primary sources, documentation, whitepapers, or benchmarks.
- **Round 3 (Adversarial & Counter-Evidence):** Actively search for criticisms, failure modes, security flaws, rival solutions, limitations, or retractions.
- **Round 4 (Gap Resolution):** Revisit thin, disputed, or single-sourced claims with alternative angles, specific query modifiers, or official docs.

### Phase 4: Maintain Claim Ledger & Confidence
Maintain a claim ledger in the working notes:
- **High Confidence:** Multiple independent primary or reputable sources agree.
- **Medium Confidence:** One strong source or secondary corroboration.
- **Low Confidence / Uncertain:** Conflicting data, single unverified vendor claim, or speculative information.

### Phase 5: Produce Authoritative Report & Deliverable
Assemble the final structured report following `references/report-template.md`:
1. Save the full report as Markdown at `~/research/reports/<topic_slug>_report.md`.
2. Automatically compile the Word deliverable using `pandoc`:
   ```bash
   pandoc ~/research/reports/<topic_slug>_report.md -o ~/research/reports/<topic_slug>_report.docx
   ```
3. Deliver a concise executive briefing in the chat:
   - Bottom-line answer (2-3 sentences)
   - Key findings with [High/Med/Low] confidence tags
   - Crucial caveats and identified risks
   - Clickable file path to the generated `.docx` and `.md` reports.

## Honesty & Integrity Rules
- Never fabricate sources, benchmarks, statistics, or URLs. Every metric must be directly traced to retrieved data.
- Clearly distinguish verified facts from model inference and speculation.
- Acknowledge genuine uncertainty and explain why conflicting sources differ.

