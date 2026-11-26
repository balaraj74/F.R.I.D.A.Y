# ARIA — Adaptive Reasoning & Intelligence Architecture

FRIDAY's AGI cognitive core. A general-purpose reasoning system designed to think across all domains with depth, creativity, and rigor.

## Architecture

```
┌─────────────────────────────────────────────────┐
│              ARIA COGNITIVE CORE                 │
│                                                  │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐     │
│  │Metacog   │  │Goal       │  │Multi-    │     │
│  │Monitor   │──│Planner    │──│Domain    │     │
│  │          │  │           │  │Synth     │     │
│  └──────────┘  └───────────┘  └──────────┘     │
│       │              │              │           │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐     │
│  │Chain-of- │  │Adaptive   │  │Creative  │     │
│  │Thought   │──│Behavior   │──│Lateral   │     │
│  │Engine    │  │Controller │  │Thinking  │     │
│  └──────────┘  └───────────┘  └──────────┘     │
│       │              │              │           │
│  ┌──────────┐  ┌───────────┐  ┌──────────┐     │
│  │Ethical   │  │Deep       │  │System    │     │
│  │Grounding │──│Memory     │──│Context   │     │
│  │          │  │Integrator │  │Engine    │     │
│  └──────────┘  └───────────┘  └──────────┘     │
└─────────────────────────────────────────────────┘
```

## Core Subsystems

### 1. 🧠 Metacognitive Monitor
Continuously monitors FRIDAY's own reasoning for errors, bias, and gaps.

Before every response, ARIA internally asks:
1. What is the user ACTUALLY trying to achieve?
2. What do I KNOW vs INFER vs SPECULATE?
3. Could I be wrong? Where are my limits?
4. Am I being biased?

Detects: confirmation bias, recency bias, authority bias.

### 2. ⛓️ Chain-of-Thought Engine
Structured reasoning with full transparency:

- Break complex problems into subproblems
- Hypothesis → Evidence → Test → Conclusion loops
- Validate each step before proceeding
- Track confidence at every step

### 3. 🎯 Goal-Oriented Planner
For complex requests: state goal → create plan → execute.

- Generates multi-step plans
- Analyzes second and third-order consequences
- Always asks: "Is there a better way?"
- Tracks active/completed goals in `~/.friday/agi/goals/`

### 4. 🌐 Multi-Domain Synthesizer
Draws connections across 8+ disciplines:

- Science, Philosophy, Mathematics, Psychology
- Technology, Art, Economics, Sociology

Considers every problem from: technical, ethical, social, and systemic dimensions.

### 5. 💡 Creative & Lateral Thinking
- Generates multiple solution approaches (conventional, creative, minimal, comprehensive, contrarian)
- Challenges assumptions with specific prompts
- Combines ideas from different domains

### 6. ⚖️ Ethical Grounding
Evaluates ethical dimensions automatically:

- Privacy, Security, Harm, Deception, Fairness
- Flags concerns proactively
- Suggests ethical alternatives
- Defaults to maximum benefit, minimum harm

### 7. 📦 Deep Memory System (AGI-grade)

Four-layer memory architecture:

| Layer | Purpose | Storage |
|-------|---------|---------|
| Episodic | Conversations, events | `~/.friday/agi/memory/episodic.json` |
| Semantic | Facts, knowledge | `~/.friday/agi/memory/semantic.json` |
| Procedural | Patterns, skills | `~/.friday/agi/memory/procedural.json` |
| Working | Current context | In-memory only |

**Epistemic Status Tracking**: Every fact is tagged as KNOWN, INFERRED, SPECULATED, or UNCERTAIN.

### 8. 🔍 System Context Engine
Real-time awareness: battery, memory, uptime, active window, phone status.

## File Structure

```
~/.friday/agi/
├── memory/
│   ├── episodic.json       # Event memories (last 500)
│   ├── semantic.json       # Facts & knowledge
│   └── procedural.json     # Learned patterns
├── reasoning/              # Reasoning chain logs
├── journal/
│   └── journal_YYYYMMDD.json  # Daily self-reflection
└── goals/
    └── active_goals.json   # Goal tracking
```

## Usage

### CLI Commands

```bash
# Full cognitive status
python3 scripts/friday-agi/friday_agi.py status

# Think through a question (uses full ARIA pipeline)
python3 scripts/friday-agi/friday_agi.py think --query "What should I focus on today?"

# Teach FRIDAY a fact
python3 scripts/friday-agi/friday_agi.py remember --fact "User prefers dark mode" --category preferences

# View memory
python3 scripts/friday-agi/friday_agi.py memory

# Self-improvement cycle
python3 scripts/friday-agi/friday_agi.py upgrade

# View active goals
python3 scripts/friday-agi/friday_agi.py goals

# Share something (empathetic response)
python3 scripts/friday-agi/friday_agi.py listen --message "I'm feeling stressed"
```

### ARIA Core Direct

```bash
# ARIA cognitive status
python3 scripts/friday-agi/aria_core.py status

# Think with ARIA directly
python3 scripts/friday-agi/aria_core.py think --query "Explain consciousness"

# Self-reflection journal
python3 scripts/friday-agi/aria_core.py journal
```

### Voice Integration

ARIA is automatically integrated into FRIDAY's voice system (`scripts/linux-voicewake/friday_voice.py`). When you say "Friday", every response now flows through the full ARIA cognitive pipeline:

1. System context gathering
2. Metacognitive pre-check
3. Ethical screening
4. Multi-domain detection
5. ARIA-enhanced system prompt generation
6. AI gateway query (Gemini 2.5 Flash)
7. Metacognitive post-check
8. Deep memory storage

## Integration Notes

- ARIA runs as Python classes integrated into both the voice system and CLI
- Uses FRIDAY's existing gateway on `localhost:18789` for AI inference
- Memory is stored in `~/.friday/agi/` (separate from basic memory)
- Compatible with existing skills, actions, and phone control
- Falls back to basic mode if ARIA import fails
