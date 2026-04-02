# Software Factory — Complete Overview

> Last updated: 2026-03-29
> Update this file whenever major features land or the architecture changes.

---

## What It Is

Software Factory is an AI-powered, end-to-end software delivery platform. A user starts with a raw idea — described in plain text — and the system takes it through every stage of the development lifecycle: requirements intelligence, planning, code generation, testing, and review. The output is working code on a git branch, ready for a PR.

It is not a code assistant or a copilot. It is a **factory** — a structured pipeline with human gates, quality checks, and a feedback loop that gets smarter over time.

**Tech stack:** Next.js 14 (App Router), Supabase (Postgres + pgvector + Auth + Realtime), Claude/OpenAI (swappable via `AI_PROVIDER` env var), Tailwind CSS, Vitest, TypeScript.

---

## The Full Pipeline (5 Steps)

### Step 1 — Vision

User describes what they want to build (free-form text or structured fields: goal, tech stack, target users, key features, constraints). Claude streams back structured requirement items one by one via NDJSON over Supabase Realtime. Auto-navigates to Requirements when done.

Route: `/projects/[id]/vision`

### Step 2 — Requirements Intelligence

- **Self-critiquing AI loop** (up to 3 iterations): AI parses, scores confidence (0–100), re-parses with its own critique injected if < 80
- **Domain classification** (`saas` / `fintech` / `workflow` / `general`) — gates a domain-specific rule pack
- **Rule-based gap detection**: deterministic, 100% confidence, auto-validated
- **AI gap detection**: suggestions, require human sign-off before affecting the status gate
- **Question generation** per gap, addressed to specific stakeholder roles
- **Partial re-evaluation**: answering a question triggers targeted re-analysis on the affected requirement item — new gaps can emerge
- **Scoring**: primary = blocking count + high-risk count + coverage%; secondary = weighted internal score
- **Hard gate**: cannot reach `ready_for_dev` with unresolved critical gaps unless the user records a risk acceptance with written rationale (audited)

Route: `/projects/[id]/requirements`

### Step 3 — Planning (Human Gate 1)

Four-phase AI pipeline — eliminates JSON truncation and gives the user a live view:

1. **Architecture phase** — decomposes requirements into named components with file mappings (2048 max tokens)
2. **Per-component task generation** — one focused AI call per component (4096 max tokens each)
3. **Cross-component dependency resolution** — small AI call to sequence everything (1024 max tokens)
4. **Spec generation** — full markdown implementation spec written after the complete picture is assembled (8192 max tokens)

Tasks stream live to the UI as each component finishes. The user then gets an interactive **Plan Workspace**: inline task editing (add/edit/delete), rendered spec, branch name, file counts. Two-step confirmation before execution starts.

Route: `/projects/[id]/jobs/[jobId]/plan`

### Step 4 — Execution

Iterative coding loop (up to 10 iterations):

1. Reads files the plan identified
2. Generates code changes, applies them to the filesystem
3. Runs the real test suite
4. If tests fail → error output fed back into the next iteration
5. When tests pass → git branch created (`sf/<id>-<slug>`)

Live logs stream via Supabase Realtime throughout.

Route: `/projects/[id]/jobs/[jobId]/execution`

### Step 5 — Review (Human Gate 2)

Syntax-highlighted git diff file by file, test results (pass/fail counts). Approve (done) or Retry (another coding loop).

Route: `/projects/[id]/jobs/[jobId]/review`

**Job state machine:**
```
pending → plan_loop → awaiting_plan_approval → coding → awaiting_review → done
                                               ↑________________| (retry)
                                               failed | cancelled
```

---

## The Knowledge Layer

### Rule Packs (`lib/requirements/rules/`)

18 deterministic checks organized by domain. Each rule is a pure boolean function over the parsed requirement items.

**Core (10 rules — always run):**
| Rule | Severity |
|---|---|
| Actors defined | critical |
| Approval role defined | critical |
| Workflow states defined | critical |
| Non-functional requirements | major |
| Error handling | major |
| Data model defined | major |
| Input/output contracts | major |
| Permissions matrix | major |
| External dependencies defined | major |
| Edge cases covered | minor |

**SaaS pack (3 rules):** billing/pricing, multi-tenancy, auth strategy

**Fintech pack (3 rules):** compliance requirements, audit trail, reconciliation

**Workflow pack (3 rules):** rollback/compensation, idempotency, retry strategy

### Pattern Learning (`lib/requirements/knowledge/`)

Three fire-and-forget async enrichment functions — never block the pipeline:

- **`classifyAndSeedDomain`** — seeds a `domain_templates` row for the project+domain if none exists
- **`extractGapPattern`** — fingerprints resolved gaps (category + severity + description) into `gap_patterns`, increments occurrence count on repeat
- **`extractResolutionPattern`** — stores the resolution rationale in `resolution_patterns` linked to the gap pattern

### Vector Knowledge Cases (`knowledge_cases` table)

When a gap is resolved, the full context is stored as a knowledge case:
- `requirement_item_snapshot` — the exact requirement item (JSONB)
- `gap_snapshot` — the gap as detected
- `resolution_snapshot` — how it was resolved
- `context_tags` — domain tags for filtering
- `embedding` — 1536-dimension vector (pgvector, HNSW index, cosine similarity)

The `match_knowledge_cases` Postgres RPC function retrieves the top-N most similar past cases given a new gap's embedding. `case_feedback` (helpful/used/overridden) enables quality filtering over time.

---

## Epistemic Design Principle

> AI surfaces candidates. Humans validate. The system's trustworthiness depends on this separation being enforced — not just documented.

- **Rule-detected gaps**: facts — confidence 100, auto-validated, immediately affect the status gate
- **AI-detected gaps**: suggestions — require explicit human validation before they affect the status gate

This separation is enforced at the DB and API level.

---

## Scoring

```
coverage_pct    = 100 − (critical × 20) − (major × 10) − (minor × 3)
nfr_score       = security (34%) + performance (33%) + auditability (33%)
internal_score  = coverage_pct × 0.7 + nfr_score × 0.3
```

Primary UI: blocking count, high-risk count, coverage%. The numeric score is a secondary/internal signal only.

---

## Competitive Advantages

1. **Requirements quality as a hard gate** — cannot proceed with unresolved critical gaps; risk acceptance requires written rationale, stored in audit trail
2. **Epistemic separation between rules and AI** — rules are facts, AI is suggestions; no hallucination can silently pass or block the gate
3. **Domain intelligence that compounds** — SaaS/fintech/workflow rule packs auto-selected based on detected domain
4. **Feedback loop that learns** — gap patterns, resolution patterns, and vector knowledge cases accumulate across projects
5. **Multi-phase planning** — eliminates JSON truncation; tasks stream live; each AI call is small and bounded
6. **Iterative coding with real test feedback** — runs the actual test suite, feeds real errors back; self-corrects up to 10 iterations
7. **Human gates at the right moments** — exactly two (plan approval, review); everything else automated
8. **Swappable AI provider** — Claude or OpenAI via env var; auto-repair for malformed JSON, retry, cost tracking, rate limiting
9. **Full audit trail** — `decision_log`, `audit_log`, `ai_usage_log`, `risk_acceptances`; essential for regulated industries
10. **Live streaming everywhere** — requirements, tasks, execution logs all stream in real time via Supabase Realtime

---

## Core Thesis

> If requirements are wrong, everything downstream is wrong. Faster execution just makes failure faster.

---

## Current State

| Feature | Status |
|---|---|
| Vision step (NDJSON streaming) | Shipped |
| Requirements intelligence pipeline | Shipped |
| Multi-phase planner | Shipped |
| Planning workspace rework (live tasks + inline editing) | In progress |
| Execution loop (LocalExecutor) | Shipped |
| Review screen | Shipped |
| Docker/E2B sandbox | Not started |
| Automatic PR creation | Not started |
| File upload (PDF/DOCX) | Not started |
| Vector knowledge retrieval surfaced in UI | Not started |
