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
6. Full audit trail

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
│       ├── gap-detector.ts         # Gap detection logic
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
  created_at
)

-- Detected gaps
gaps (
  id, requirement_id, item_id,  -- item_id nullable (document-level gaps)
  severity TEXT,                -- critical | major | minor
  category TEXT,                -- missing | ambiguous | conflicting | incomplete
  description TEXT,
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

-- Append-only audit trail
audit_log (
  id, entity_type TEXT, entity_id UUID,
  action TEXT,              -- created | updated | deleted | analyzed | scored
  actor_id UUID,            -- nullable: NULL for system/pipeline actions, user UUID for human actions
  diff JSONB,               -- before/after state
  created_at
)

-- Versioned completeness scores
completeness_scores (
  id, requirement_id,
  score INTEGER,            -- 0-100
  breakdown JSONB,          -- per-dimension scores (see Scoring Formula)
  scored_at TIMESTAMPTZ
)
```

**`audit_log` is append-only.** Every mutation to any entity writes a row. This provides full auditability without event sourcing complexity.

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

**2. Gap Detection**
- AI analyzes structured items against a requirements completeness rubric
- Each gap classified by category (missing / ambiguous / conflicting / incomplete) and severity (critical / major / minor)
- Runs in parallel across items for speed
- Response schema: `{ gaps: Array<{ item_id, severity, category, description }> }`

**3. Question Generation**
- One AI call per gap (N gaps = N calls, run in parallel)
- Each call receives the gap and its linked requirement item as context
- Each question assigned a `target_role` (ba / architect / po / dev) by the AI based on:
  - `ambiguous` → `ba`
  - `missing` / `incomplete` (business/product concern) → `po`; (process/technical detail) → `ba`
  - `conflicting` (technical) → `architect`; (business rules) → `po`
- The AI determines ba vs po for `missing`/`incomplete` based on whether the gap concerns product decisions (po) or requirements detail/process (ba)
- Response schema per call: `{ question_text: string, target_role: "ba" | "architect" | "po" | "dev" }`

**4. Investigation Task Creation**
- Critical and major gaps automatically produce investigation tasks
- Title, description, and priority pre-filled from gap context
- Status defaults to `open`

**5. Completeness Scoring**
- Produces a score 0–100 using an equal-weight average across 4 dimensions (25 points each):

  | Dimension | How scored |
  |---|---|
  | **Functional coverage** | % of functional requirement items that have no `missing` or `incomplete` gaps |
  | **Ambiguity** | % of requirement items with no `ambiguous` gaps |
  | **Consistency** | `max(0, 100 - (conflicting_gap_count × 25))` |
  | **Non-functional presence** | 100 if ≥1 non-functional requirement item exists; 0 otherwise |

- Final score = `(dim1 + dim2 + dim3 + dim4) / 4`, rounded to nearest integer
- Breakdown stored as JSONB: `{ functional_coverage: N, ambiguity: N, consistency: N, nfr_presence: N }`

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
- Completeness score bar (0–100) at top of view with dimension breakdown on hover
- Last-write-wins for concurrent edits in MVP — no conflict resolution UI

### View 3: Gaps & Questions
- Prioritized list of all detected gaps (critical → major → minor)
- Each gap expands to show:
  - Clarifying question with target role badge (BA / Architect / PO / Dev)
  - Inline answer input field (for stakeholder responses)
  - Linked investigation task with status badge

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
| Unit | Core domain logic (`parser`, `gap-detector`, `scorer`) with static fixture inputs — no AI calls |
| Integration | Pipeline API route with test Supabase instance + mock AI provider returning fixture JSON |
| E2E | Playwright: submit input → structured output → gaps view |

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
6. Every action is recorded in the audit log
7. The AI provider can be swapped by changing the `AI_PROVIDER` environment variable with no code changes
