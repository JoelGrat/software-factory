# Phase 1: Requirements Intelligence — Design Spec

**Project:** AI-Powered Software Factory
**Phase:** 1 of 5
**Date:** 2026-03-23
**Status:** In Review

---

## Overview

Phase 1 builds the Requirements Intelligence layer — the foundation of the software factory. The core thesis: if requirements are wrong, everything downstream is wrong. Faster execution just makes failure faster.

Phase 1 takes messy, unstructured input (plain text or markdown pasted into a textarea — see Input Format below) and transforms it into structured, gap-analyzed, auditable requirements with a measurable completeness score.

---

## Scope (MVP)

1. Ingest raw text input → structure into discrete requirement items
2. Detect gaps (missing, ambiguous, conflicting, incomplete)
3. Generate clarifying questions per gap (with target stakeholder role)
4. Create investigation tasks for critical/major gaps
5. Completeness scoring (0–100) with defined formula
6. Full audit trail (`audit_log`) + decision traceability (`decision_log`)

---

## Input Format

For MVP, raw input is **plain text or markdown pasted into a textarea**. File upload (PDF, DOCX) is out of scope for Phase 1. Supabase Storage is included in the stack but not used until file upload is added in a future phase.

Accepted input examples:
- Free-text descriptions
- Bullet-point lists
- User story format (`As a... I want... So that...`)
- Meeting notes
- Mix of the above in a single paste

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend + API | Next.js 14 (App Router, TypeScript) |
| Database + Auth | Supabase (Postgres) |
| Storage | Supabase Storage (provisioned, unused in Phase 1) |
| AI | Model-agnostic provider interface (Claude, OpenAI, etc.) |
| Realtime | Supabase Realtime (pipeline progress only in MVP) |
| Testing | Vitest (unit/integration), Playwright (E2E) |

---

## Architecture

```
softwareFactory_git/
├── app/
│   ├── (auth)/                     # Login/signup routes
│   ├── projects/
│   │   └── [id]/requirements/      # Requirements workspace (3 views)
│   └── api/
│       ├── requirements/           # analyze, items, gaps, questions, tasks
│       └── ai/                     # AI provider proxy
├── lib/
│   ├── ai/
│   │   ├── provider.ts             # Provider abstraction interface
│   │   ├── adapters/               # Claude, OpenAI, etc. adapters
│   │   └── prompts/                # Prompt templates per pipeline step
│   ├── supabase/                   # DB client + generated types
│   └── requirements/
│       ├── parser.ts               # Structure raw input
│       ├── gap-detector.ts         # Gap detection orchestrator (runs rules + AI, merges results)
│       ├── rules/                  # Rule-based checks (pure functions, no AI)
│       │   ├── has-approval-role.ts
│       │   ├── has-workflow-states.ts
│       │   ├── has-nfrs.ts
│       │   ├── has-error-handling.ts
│       │   └── has-actors-defined.ts
│       ├── scorer.ts               # Completeness scoring
│       └── question-generator.ts   # Clarifying question generation
└── components/
    ├── requirements/               # Workspace UI components
    └── ui/                         # Shared UI primitives
```

### AI Provider Interface

`lib/ai/provider.ts` defines a single contract:

```typescript
interface CompletionOptions {
  responseSchema?: Record<string, unknown> // JSON Schema for structured output
  temperature?: number
  maxTokens?: number
}

interface AIProvider {
  complete(prompt: string, options?: CompletionOptions): Promise<string>
}
```

**Contract:** When `responseSchema` is provided, the adapter MUST return a valid JSON string conforming to that schema (enforced via JSON mode, function calling, or equivalent). The return type is always `string`; callers parse it. If the returned string is not valid JSON when a schema was requested, the pipeline step errors and surfaces a retry action.

Each model adapter implements this interface. The active provider is selected via the `AI_PROVIDER` environment variable (e.g., `AI_PROVIDER=claude` or `AI_PROVIDER=openai`). Swapping providers requires changing this variable — no code changes. Each adapter lives in `lib/ai/adapters/` and is registered in a provider registry at `lib/ai/registry.ts`.

---

## Data Model

```sql
-- Top-level workspace
projects (id, name, owner_id, created_at)

-- Requirements document
requirements (
  id, project_id, title,
  raw_input TEXT,           -- original pasted text
  status TEXT,              -- draft | analyzing | structured | reviewed | approved
  created_at, updated_at
)

-- Structured items extracted from raw input
requirement_items (
  id, requirement_id,
  type TEXT,                -- functional | non-functional | constraint | assumption
  title TEXT,
  description TEXT,
  priority TEXT,            -- high | medium | low
  source_text TEXT,         -- original snippet this was extracted from
  nfr_category TEXT,        -- nullable: security | performance | auditability (only for non-functional items)
  created_at
)

-- Detected gaps
gaps (
  id, requirement_id, item_id,  -- item_id nullable (document-level gaps)
  severity TEXT,                -- critical | major | minor
  category TEXT,                -- missing | ambiguous | conflicting | incomplete
  description TEXT,
  source TEXT,                  -- "rule" (deterministic) | "ai" (contextual)
  rule_id TEXT,                 -- nullable: name of the rule function if source = "rule"
  priority_score INTEGER,       -- impact × uncertainty (see Gap Prioritization)
  confidence INTEGER,           -- 0-100: AI certainty this is a real gap (100 for rule-sourced gaps)
  question_generated BOOLEAN,   -- false until a question is generated for this gap
  merged_into UUID,             -- nullable: if this gap was merged into another
  created_at
)

-- Clarifying questions generated from gaps
questions (
  id, gap_id,
  requirement_id UUID,      -- denormalized for direct querying without join through gaps
  question_text TEXT,
  target_role TEXT,         -- ba | architect | po | dev (stakeholder this question is for)
  status TEXT,              -- open | answered | dismissed
  answer TEXT,              -- nullable until answered
  answered_at TIMESTAMPTZ,
  created_at
)

-- Actionable investigation tasks
investigation_tasks (
  id, requirement_id, linked_gap_id,
  title TEXT, description TEXT,
  priority TEXT,            -- high | medium | low
  status TEXT,              -- open | in-progress | resolved | dismissed
  created_at
)

-- Append-only audit trail (what changed)
audit_log (
  id, entity_type TEXT, entity_id UUID,
  action TEXT,              -- created | updated | deleted | analyzed | scored
  actor_id UUID,            -- nullable: NULL for system/pipeline actions, user UUID for human actions
  diff JSONB,               -- before/after state
  created_at
)

-- Decision traceability (why it was decided)
decision_log (
  id,
  requirement_id UUID,
  related_gap_id UUID,      -- nullable: the gap this decision resolves (if any)
  related_question_id UUID, -- nullable: the question this decision answers (if any)
  decision TEXT,            -- what was decided
  rationale TEXT,           -- why — the reasoning, context, constraints considered
  decided_by UUID,          -- user who recorded the decision (NOT nullable — decisions need an owner)
  created_at
)

-- Versioned completeness scores
completeness_scores (
  id, requirement_id,
  overall_score INTEGER,    -- 0-100: weighted combination of completeness + nfr
  completeness INTEGER,     -- 0-100: gap-penalty score
  nfr_score INTEGER,        -- 0-100: NFR category coverage
  confidence INTEGER,       -- 0-100: average AI confidence across AI-sourced gaps
  breakdown JSONB,          -- full breakdown (see Scoring Formula)
  scored_at TIMESTAMPTZ
)
```

**Two logs, distinct purposes:**

| | `audit_log` | `decision_log` |
|---|---|---|
| Answers | *What changed?* | *Why was this decided?* |
| Written by | System (automatic) | User (explicit) |
| Structure | entity + diff | decision + rationale |
| Required | Always | When a decision is made |

`audit_log` is append-only and written automatically on every mutation. `decision_log` is written explicitly by users when they resolve a gap, dismiss a question, or override a requirement — and requires both a `decision` and a `rationale`. A decision without rationale cannot be saved.

**`questions.requirement_id` is denormalized** — it duplicates the `gaps.requirement_id` value for direct querying. Queries like "all questions for a requirement" use this directly without joining through `gaps`.

---

## Core Processing Pipeline

Triggered by `POST /api/requirements/analyze`. Runs sequentially; each step writes to `audit_log`.

### Steps

**1. Parse & Structure**
- AI reads raw input
- Extracts discrete requirement items
- Classifies each: functional / non-functional / constraint / assumption
- Links each item back to the original source text (traceability)
- Response schema: `{ items: Array<{ type, title, description, priority, source_text }> }`

**2. Gap Detection** *(hybrid: rules first, then AI)*

Gap detection runs in two layers. Rule-based checks fire first and produce deterministic gaps. AI analysis runs after and produces contextual gaps. Both produce the same `Gap` shape — they are merged before step 3.

**Layer A — Rule-based checks (deterministic)**

Implemented in `gap-detector.ts` as pure functions over the structured items array. Each rule either fires or doesn't — no probability, no "maybe". A fired rule always produces a gap with a fixed severity and description.

Initial rule set:

| Rule | Check | Severity |
|---|---|---|
| `hasApprovalRole` | At least one item defines who approves or signs off | `critical` |
| `hasWorkflowStates` | At least one item defines system states or status transitions | `critical` |
| `hasNonFunctionalRequirements` | At least one item is classified as `non-functional` | `major` |
| `hasErrorHandling` | At least one item addresses failure, error, or exception behaviour | `major` |
| `hasActorsDefined` | At least one item names a user role or system actor | `critical` |

Rules are implemented as named, testable functions:
```typescript
// gap-detector.ts
function hasApprovalRole(items: RequirementItem[]): boolean { ... }

if (!hasApprovalRole(items)) {
  addGap("missing", "No approval role defined", "critical")
}
```

Rules are independently unit-testable with no AI calls. New rules are added by writing a function + a check — no prompt changes required.

**Layer B — AI analysis (contextual)**

- AI analyzes the full structured items list against a completeness rubric
- Finds gaps that require reasoning: ambiguity, implicit conflicts, domain-specific omissions
- Each gap classified by category (missing / ambiguous / conflicting / incomplete) and severity (critical / major / minor)
- Response schema: `{ gaps: Array<{ item_id, severity, category, description }> }`

**Merge:** Rule-based gaps are tagged `source: "rule"`, AI gaps tagged `source: "ai"`. Both are stored in the `gaps` table. The `source` field is added to the schema (see Data Model). This allows future filtering, reporting, and rule auditing.

**3. Gap Prioritization** *(runs before question generation)*

Not every gap warrants a question. Before generating questions, all gaps are scored and ranked.

**Priority score formula:**
```
priority = impact × uncertainty

impact:      critical=3, major=2, minor=1
uncertainty: missing=3, ambiguous=2, conflicting=2, incomplete=1
```

Gaps are sorted by priority score descending. Only the **top 10 gaps** proceed to question generation. The rest are stored in the `gaps` table with `question_generated: false` — they remain visible in the UI but without a question attached.

**Grouping similar gaps:** Before ranking, gaps that share the same `category` and `item_id` are merged into a single representative gap. This prevents the same underlying issue producing multiple questions. Merging is deterministic — the highest-severity gap in the group is kept; others are stored with `merged_into: <gap_id>`.

The `gaps` table gains two fields: `priority_score INTEGER` and `question_generated BOOLEAN` (default false).

**4. Question Generation**
- Runs only for gaps where `question_generated` will be set to `true` (top 10 after prioritization)
- One AI call per selected gap, run in parallel
- Each call receives the gap and its linked requirement item as context
- Each question assigned a `target_role` (ba / architect / po / dev) by the AI based on:
  - `ambiguous` → `ba`
  - `missing` / `incomplete` (business/product concern) → `po`; (process/technical detail) → `ba`
  - `conflicting` (technical) → `architect`; (business rules) → `po`
- The AI determines ba vs po for `missing`/`incomplete` based on whether the gap concerns product decisions (po) or requirements detail/process (ba)
- Response schema per call: `{ question_text: string, target_role: "ba" | "architect" | "po" | "dev" }`

The user can explicitly request a question for any ungrouped gap via a "Generate question" action — this triggers a single on-demand AI call for that gap.

**5. Investigation Task Creation**
- Critical and major gaps automatically produce investigation tasks
- Title, description, and priority pre-filled from gap context
- Status defaults to `open`

**6. Completeness Scoring**

Produces two separate scores: **completeness** and **confidence**. Both are stored in `completeness_scores`.

---

**Completeness score (0–100)**

Starts at 100. Deduct for every gap detected:

```
score = max(0, 100 - (critical_count × 20) - (major_count × 10) - (minor_count × 3))
```

Critical gaps are expensive. A document with 5 critical gaps scores 0 regardless of how many minor things are fine.

---

**NFR coverage score (0–100, separate dimension)**

Binary NFR presence is replaced with per-category coverage. Each category is independently scored:

| NFR Category | Present | Absent |
|---|---|---|
| Security | +34 | 0 |
| Performance | +33 | 0 |
| Auditability | +33 | 0 |

`nfr_score = sum of present categories` (0, 33, 34, 66, 67, or 100)

NFR presence is determined by the structured items from step 1 — any `non-functional` item whose description matches the category keyword set (e.g., "auth", "encrypt", "access" → security). The AI classifies NFR items into categories during parsing (add `nfr_category` field to `requirement_items` for non-functional items).

---

**Final breakdown:**

```
completeness_score = max(0, 100 - (critical × 20) - (major × 10) - (minor × 3))
nfr_score          = sum of covered NFR categories (0–100)
overall_score      = round((completeness_score × 0.7) + (nfr_score × 0.3))
```

Overall score weights completeness at 70% and NFR coverage at 30%.

---

**Confidence score (0–100, separate from completeness)**

Completeness measures *what is there*. Confidence measures *how certain the AI is about what it found*.

The AI returns a confidence value per gap during gap detection (Layer B only — rule-based gaps have confidence 100 by definition):

```typescript
// gap detection AI response
{ gaps: Array<{ item_id, severity, category, description, confidence: number }> }
// confidence: 0–100, where 100 = "this is definitely a gap"
```

Overall confidence score = average confidence across all AI-sourced gaps. A high completeness score with low confidence means "it looks complete, but the AI wasn't sure what it was reading." Both scores are shown in the UI.

---

**Stored breakdown JSONB:**
```json
{
  "completeness": 72,
  "nfr_score": 67,
  "overall": 71,
  "confidence": 84,
  "gap_counts": { "critical": 1, "major": 2, "minor": 4 },
  "nfr_coverage": { "security": true, "performance": true, "auditability": false }
}
```

### Failure Handling
- Each step is independently committed — if gap detection fails, structured items still save
- Failures write to `audit_log`
- Users see a "partial analysis" state with a per-step retry button
- AI errors surface the specific failed step, not a generic error

---

## UI — Requirements Workspace

Three tabbed views at `projects/[id]/requirements/`:

### View 1: Input
- Textarea for pasting raw requirements (plain text or markdown)
- "Analyze" button triggers pipeline
- Real-time status bar showing pipeline step progress (via Supabase Realtime)
- After analysis completes, user is automatically navigated to View 2

### View 2: Structured Requirements
- Requirement items grouped by type (functional / non-functional / constraint / assumption)
- Each item shows: extracted requirement, source text snippet, attached gaps (severity badge)
- Two scores shown at top of view: **Completeness** (0–100) and **Confidence** (0–100)
  - Completeness bar with breakdown on hover: gap-penalty score, NFR coverage (per category), overall weighted score
  - Confidence displayed as a secondary indicator — low confidence flags that the AI was uncertain about its analysis
- Last-write-wins for concurrent edits in MVP — no conflict resolution UI

### View 3: Gaps & Questions
- Default view shows **top 10 gaps with questions** only (sorted by priority score)
- "Show all gaps" toggle reveals the full list including low-priority and merged gaps
- Each gap with a question expands to show:
  - Clarifying question with target role badge (BA / Architect / PO / Dev)
  - Inline answer input field (for stakeholder responses)
  - "Record Decision" action: opens a two-field form (decision + rationale, both required) that writes to `decision_log` and marks the gap resolved
  - Linked investigation task with status badge
- Each gap without a question shows a "Generate question" button (on-demand, single AI call)
- Merged gaps are shown collapsed under their representative gap with a count badge ("+ 2 similar")

**Note on collaboration:** Supabase Realtime is used in MVP for pipeline progress only. Concurrent editing of requirement items uses last-write-wins — the last save overwrites silently. Real-time collaborative editing is deferred to a future phase.

---

## Error Handling

- Pipeline failures are partial — users see what succeeded, not a blank error
- All errors recorded in `audit_log`
- AI provider errors surface the specific step that failed with a retry action
- No silent failures — every error state is visible in the UI

---

## Testing Strategy

| Layer | Approach |
|---|---|
| Unit (rules) | Each rule function tested independently with fixture item arrays — zero AI calls, fully deterministic |
| Unit (domain) | `parser`, `scorer`, `gap-detector` orchestrator with mock rule results + mock AI responses |
| Integration | Full pipeline API route with test Supabase instance + mock AI provider returning fixture JSON |
| E2E | Playwright: submit input → structured output → gaps view (includes rule-sourced gaps) |

Rule tests are the most important unit tests in the system — they are the only place where "this is definitely missing" is asserted. Each rule function gets its own test file covering: fires correctly, does not fire when satisfied, edge cases.

The mock AI provider returns deterministic fixture responses and implements the `AIProvider` interface — it makes the full pipeline testable without real AI calls or network access.

---

## What's Out of Scope for Phase 1

- File upload (PDF, DOCX) — textarea input only
- Real-time collaborative editing — last-write-wins for now
- Re-scoring after a question is answered — the completeness score is computed once at the end of the pipeline and is static until a full re-analysis is triggered
- Completeness validation against external standards (Phase 2)
- Test case generation (Phase 3)
- Ticket/issue generation (Phase 4)
- Agent-driven automation (Phase 5)
- Integration with Jira, GitHub, Confluence (Phase 4)
- Role-based access control beyond basic auth

---

## Success Criteria

Phase 1 is complete when:
1. A user can paste raw text requirements and receive structured items with source traceability
2. Gaps are detected with severity and category
3. Each gap has a clarifying question with a target stakeholder role assigned
4. Critical/major gaps have auto-generated investigation tasks with `open` status
5. A completeness score (0–100) is shown with a 4-dimension breakdown
6. Every mutation is recorded in the audit log; every resolved gap can have a decision + rationale in the decision log
7. A decision record cannot be saved without both `decision` and `rationale` fields populated
8. The AI provider can be swapped by changing the `AI_PROVIDER` environment variable with no code changes
