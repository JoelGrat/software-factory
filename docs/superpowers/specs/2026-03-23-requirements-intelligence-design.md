# Phase 1: Requirements Intelligence — Design Spec

**Project:** AI-Powered Software Factory
**Phase:** 1 of 5
**Date:** 2026-03-23
**Status:** Approved

---

## Overview

Phase 1 builds the Requirements Intelligence layer — the foundation of the software factory. The core thesis: if requirements are wrong, everything downstream is wrong. Faster execution just makes failure faster.

Phase 1 takes messy, unstructured input (free-text documents, meeting notes, user stories, templates — any format) and transforms it into structured, gap-analyzed, auditable requirements with a measurable completeness score.

---

## Scope (MVP)

1. Ingest raw input in any format → structure into discrete requirement items
2. Detect gaps (missing, ambiguous, conflicting, incomplete)
3. Generate clarifying questions per gap
4. Create investigation tasks for critical/major gaps
5. Completeness scoring (0–100)
6. Full audit trail

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend + API | Next.js 14 (App Router, TypeScript) |
| Database + Auth + Storage | Supabase (Postgres) |
| AI | Model-agnostic provider interface (Claude, OpenAI, etc.) |
| Realtime | Supabase Realtime (pipeline progress, collaborative editing) |
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
interface AIProvider {
  complete(prompt: string, options?: CompletionOptions): Promise<string>
}
```

Each model adapter implements this interface. Swapping providers requires changing one config value — prompts and pipeline logic are provider-agnostic.

---

## Data Model

```sql
-- Top-level workspace
projects (id, name, owner_id, created_at)

-- Requirements document
requirements (
  id, project_id, title,
  raw_input TEXT,           -- original unstructured input
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
  question_text TEXT,
  status TEXT,              -- open | answered | dismissed
  answer TEXT,              -- nullable until answered
  answered_at TIMESTAMPTZ,
  created_at
)

-- Actionable investigation tasks
investigation_tasks (
  id, requirement_id, linked_gap_id,
  title TEXT, description TEXT,
  priority TEXT, status TEXT,
  created_at
)

-- Append-only audit trail
audit_log (
  id, entity_type TEXT, entity_id UUID,
  action TEXT,              -- created | updated | deleted | analyzed | scored
  actor_id UUID,
  diff JSONB,               -- before/after state
  created_at
)

-- Versioned completeness scores
completeness_scores (
  id, requirement_id,
  score INTEGER,            -- 0-100
  breakdown JSONB,          -- per-dimension scores
  scored_at TIMESTAMPTZ
)
```

**`audit_log` is append-only.** Every mutation to any entity writes a row. This provides full auditability without event sourcing complexity.

---

## Core Processing Pipeline

Triggered by `POST /api/requirements/analyze`. Runs sequentially; each step writes to `audit_log`.

### Steps

**1. Parse & Structure**
- AI reads raw input (any format)
- Extracts discrete requirement items
- Classifies each: functional / non-functional / constraint / assumption
- Links each item back to the original source text (traceability)

**2. Gap Detection**
- AI analyzes structured items against a requirements completeness rubric
- Each gap classified by category (missing / ambiguous / conflicting / incomplete) and severity (critical / major / minor)
- Runs in parallel across items for speed

**3. Question Generation**
- One focused clarifying question generated per gap
- Questions are targeted at the appropriate stakeholder role (BA, architect, PO)

**4. Investigation Task Creation**
- Critical and major gaps automatically produce investigation tasks
- Title, description, and priority pre-filled from gap context

**5. Completeness Scoring**
- Score 0–100 based on:
  - Coverage of functional areas
  - Absence of ambiguity
  - No conflicting requirements
  - Non-functional requirements present
- Breakdown stored as JSONB (rubric can evolve without schema migration)

### Failure Handling
- Each step is independently committed — if gap detection fails, structured items still save
- Failures write to `audit_log`
- Users see a "partial analysis" state with a per-step retry button
- AI errors surface the specific failed step, not a generic error

---

## UI — Requirements Workspace

Three tabbed views at `projects/[id]/requirements/`:

### View 1: Input
- Rich text area for raw requirements input (any format)
- "Analyze" button triggers pipeline
- Real-time status bar showing pipeline step progress (via Supabase Realtime)

### View 2: Structured Requirements
- Requirement items grouped by type (functional / non-functional / constraint / assumption)
- Each item shows: extracted requirement, source text link, attached gaps (severity badge)
- Completeness score bar (0–100) at top of view
- All changes persist in real time; multiple users can collaborate simultaneously

### View 3: Gaps & Questions
- Prioritized list of all detected gaps
- Each gap expands to show:
  - Clarifying question
  - Inline answer input field (for stakeholder responses)
  - Linked investigation task with status

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
| Integration | Pipeline API route with test Supabase instance + mock AI provider returning fixtures |
| E2E | Playwright: submit input → structured output → gaps view |

The mock AI provider is deterministic and fast — it makes the full pipeline testable without real AI calls.

---

## What's Out of Scope for Phase 1

- Completeness validation against external standards (Phase 2)
- Test case generation (Phase 3)
- Ticket/issue generation (Phase 4)
- Agent-driven automation (Phase 5)
- Integration with Jira, GitHub, Confluence (Phase 4)
- Role-based access control beyond basic auth

---

## Success Criteria

Phase 1 is complete when:
1. A user can paste raw requirements in any format and receive structured items
2. Gaps are detected with severity and category
3. Each gap has a clarifying question and (for critical/major) an investigation task
4. A completeness score is shown with a breakdown
5. Every action is recorded in the audit log
6. The AI provider can be swapped via config with no code changes
