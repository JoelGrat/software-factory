# Phase 1: Requirements Intelligence — Design Spec v2

**Project:** AI-Powered Software Factory
**Phase:** 1 of 5
**Date:** 2026-03-25
**Supersedes:** `2026-03-23-requirements-intelligence-design.md`
**Status:** In Review

---

## What Changed From v1

| # | Issue | Change |
|---|---|---|
| 1 | AI output treated as objective truth | Epistemic separation: AI suggests, humans validate. Only validated gaps affect the status gate. |
| 2 | Naive, exploitable scoring formula | Numeric score kept as internal/secondary metric only. Primary UI shows blocking issues, high-risk areas, coverage%. Scoring normalized by density. |
| 3 | Status gate too rigid — will get bypassed socially | Risk acceptance added. Critical gaps must be resolved OR explicitly accepted to clear the gate. |
| 4 | Top 10 gap cutoff hides critical context | Critical gaps always included. Limit applies only to non-critical gaps. |
| 5 | Rule set too shallow | Rule packs introduced, organized by domain. Expanded rule coverage across 8 categories. |
| 6 | Knowledge layer overhyped, under-specified | Replaced with `knowledge_cases` (raw, high-fidelity). Embeddings + similarity retrieval. Feedback loop. No LLM abstraction. |
| 7 | Partial re-evaluation logically inconsistent | Answers can now create new gaps (targeted re-analysis on affected requirement item). |
| 8 | AI provider abstraction too thin | Retries, timeout, cost tracking, rate limiting, structured errors, auto-repair JSON, fallback provider. |
| 9 | No concept of requirement relationships | `requirement_relations` table added (depends_on, conflicts_with, refines). Conflict detection in gap detection. |
| 10 | Optimizing for analysis, not outcomes | Risk prediction, delivery impact, complexity estimation added to summary panel and scoring. |

---

## Overview

Phase 1 builds the Requirements Intelligence layer — the foundation of the software factory. The core thesis: if requirements are wrong, everything downstream is wrong. Faster execution just makes failure faster.

Phase 1 takes messy, unstructured input (plain text or markdown pasted into a textarea) and transforms it into structured, gap-analyzed, auditable requirements with human-validated completeness signals.

**Design principle:** AI surfaces candidates. Humans validate. The system's trustworthiness depends on this separation being enforced — not just documented.

---

## Scope (MVP)

1. Ingest raw text input → structure into discrete requirement items
2. Detect gaps (missing, ambiguous, conflicting, incomplete) — AI suggests, humans validate
3. Generate clarifying questions per gap (with target stakeholder role)
4. Create investigation tasks for critical/major gaps
5. Completeness signals: primary = blocking issues / high-risk areas / coverage%; secondary = internal numeric score
6. Full audit trail (`audit_log`) + decision traceability (`decision_log`)
7. Status gate — requirements cannot reach `ready_for_dev` while unresolved critical gaps remain (unless explicitly accepted with rationale)
8. Partial re-evaluation — answering a question triggers targeted re-analysis on the affected requirement item; new gaps may emerge
9. Knowledge layer — high-fidelity cases stored with embeddings; similarity retrieval surfaces relevant past situations
10. Requirement relationships — dependencies, conflicts, and refinements between requirement items
11. Risk prediction — delivery impact and complexity signals surfaced alongside gap analysis

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
| Database + Auth | Supabase (Postgres + pgvector) |
| Storage | Supabase Storage (provisioned, unused in Phase 1) |
| AI | Model-agnostic provider interface (Claude, OpenAI, etc.) |
| Realtime | Supabase Realtime (pipeline progress + score updates) |
| Testing | Vitest (unit/integration), Playwright (E2E) |

**pgvector** is required for the knowledge layer (embedding similarity search). Enable the `vector` extension in Supabase.

---

## Architecture

```
softwareFactory_git/
├── app/
│   ├── (auth)/                     # Login/signup routes
│   ├── projects/
│   │   └── [id]/requirements/      # Requirements workspace (3 views)
│   └── api/
│       ├── requirements/           # analyze, items, gaps, questions, tasks, status, summary
│       └── ai/                     # AI provider proxy
├── lib/
│   ├── ai/
│   │   ├── provider.ts             # Provider abstraction interface
│   │   ├── adapters/               # Claude, OpenAI, etc. adapters
│   │   ├── prompts/                # Prompt templates per pipeline step
│   │   └── repair.ts               # JSON auto-repair + retry logic
│   ├── supabase/                   # DB client + generated types
│   └── requirements/
│       ├── parser.ts               # Structure raw input
│       ├── gap-detector.ts         # Gap detection orchestrator (rules + AI + relation checks)
│       ├── rules/                  # Rule-based checks organized by domain
│       │   ├── core/               # Always-on rules (actors, approval, states, NFRs, errors)
│       │   ├── saas/               # SaaS-specific rules (billing, tenancy, auth)
│       │   ├── fintech/            # Fintech rules (compliance, audit, reconciliation)
│       │   └── workflow/           # Workflow rules (state transitions, rollback, retries)
│       ├── scorer.ts               # Completeness signals (density-normalized)
│       ├── question-generator.ts   # Clarifying question generation
│       ├── relation-detector.ts    # Requirement relationship detection
│       ├── risk-predictor.ts       # Delivery risk and complexity estimation
│       └── knowledge/
│           ├── case-store.ts       # Write knowledge_cases on gap resolution
│           ├── retriever.ts        # Embed + query similar cases
│           └── feedback.ts         # case_feedback write path
└── components/
    ├── requirements/               # Workspace UI components
    └── ui/                         # Shared UI primitives
```

### AI Provider Interface

`lib/ai/provider.ts` defines the contract:

```typescript
interface CompletionOptions {
  responseSchema?: Record<string, unknown>  // JSON Schema for structured output
  temperature?: number
  maxTokens?: number
  timeout?: number                          // ms, default: 30000
  maxRetries?: number                       // default: 3
  fallbackProvider?: string                 // provider ID to use if primary fails
}

interface CompletionResult {
  content: string
  provider: string                          // which provider actually responded
  model: string
  inputTokens: number
  outputTokens: number
  retryCount: number                        // how many retries were needed
  latencyMs: number
}

interface AIProvider {
  complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult>
}
```

**Reliability contract:**

1. If the returned string is not valid JSON when a schema was requested, `lib/ai/repair.ts` attempts auto-repair (common JSON fixes: trailing commas, missing brackets, truncated strings)
2. If repair fails, the adapter retries with `temperature: 0` (up to `maxRetries`)
3. If all retries fail and `fallbackProvider` is set, the request is forwarded to the fallback provider
4. If everything fails, the step errors with a structured `AIProviderError` — never a raw exception
5. All calls log input tokens, output tokens, latency, and retry count to `ai_usage_log` for cost tracking

Rate limiting is handled per-adapter. Each adapter exposes a `rateLimit` config (requests/minute). The orchestrator backs off when the adapter reports rate limit exhaustion.

Each model adapter implements `AIProvider`. The active provider is selected via `AI_PROVIDER` env var. Swapping providers requires only changing this variable — no code changes.

---

## Data Model

```sql
-- Top-level workspace
projects (id, name, owner_id, created_at)

-- Requirements document
requirements (
  id, project_id, title,
  raw_input TEXT,           -- original pasted text
  domain TEXT,              -- nullable: detected domain (saas | fintech | workflow | general)
  status TEXT,              -- see Status Gate below
  blocked_reason TEXT,      -- nullable: populated when status = blocked
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
  nfr_category TEXT,        -- nullable: security | performance | auditability (non-functional only)
  created_at
)

-- Relationships between requirement items
requirement_relations (
  id,
  source_id UUID REFERENCES requirement_items(id),
  target_id UUID REFERENCES requirement_items(id),
  type TEXT,                -- depends_on | conflicts_with | refines
  detected_by TEXT,         -- rule | ai
  created_at
)

-- Detected gaps
gaps (
  id, requirement_id,
  item_id UUID,             -- nullable: document-level gaps have no item
  severity TEXT,            -- critical | major | minor
  category TEXT,            -- missing | ambiguous | conflicting | incomplete
  description TEXT,
  source TEXT,              -- rule | ai | relation (new: from relation conflict detection)
  rule_id TEXT,             -- nullable: rule function name if source = rule
  priority_score INTEGER,   -- impact × uncertainty (see Gap Prioritization)
  validated BOOLEAN DEFAULT false,  -- has a human confirmed this is a real gap?
  validated_by UUID,        -- nullable: user who validated; NULL = not yet validated
  question_generated BOOLEAN DEFAULT false,
  merged_into UUID,         -- nullable: merged gap reference
  resolved_at TIMESTAMPTZ,
  resolution_source TEXT,   -- nullable: question_answered | task_resolved | decision_recorded | risk_accepted
  created_at
)

-- Risk acceptances (explicit bypass of status gate for unresolved critical gaps)
risk_acceptances (
  id,
  gap_id UUID REFERENCES gaps(id),
  accepted_by UUID,         -- user who accepted the risk (NOT nullable)
  rationale TEXT NOT NULL,  -- why this risk is acceptable right now
  expires_at TIMESTAMPTZ,   -- nullable: acceptance can be time-bounded
  created_at
)

-- Clarifying questions generated from gaps
questions (
  id, gap_id,
  requirement_id UUID,      -- denormalized for direct querying
  question_text TEXT,
  target_role TEXT,         -- ba | architect | po | dev
  status TEXT,              -- open | answered | dismissed
  answer TEXT,
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
  action TEXT,              -- created | updated | deleted | analyzed | scored | risk_accepted
  actor_id UUID,            -- NULL for system, UUID for user
  diff JSONB,
  created_at
)

-- Decision traceability
decision_log (
  id,
  requirement_id UUID,
  related_gap_id UUID,      -- nullable
  related_question_id UUID, -- nullable
  decision TEXT NOT NULL,
  rationale TEXT NOT NULL,  -- both fields required — no rationale, no save
  decided_by UUID NOT NULL,
  created_at
)

-- Versioned completeness signals
completeness_scores (
  id, requirement_id,
  -- Primary signals (shown in UI)
  blocking_count INTEGER,         -- unresolved critical gaps (validated only)
  high_risk_count INTEGER,        -- unresolved major gaps (validated only)
  coverage_pct INTEGER,           -- 0-100: requirement areas covered vs expected for domain
  -- Secondary signals (internal)
  internal_score INTEGER,         -- 0-100: density-normalized weighted score
  nfr_score INTEGER,              -- 0-100: NFR category coverage
  -- Risk signals
  complexity_score INTEGER,       -- 0-100: estimated delivery complexity
  risk_flags JSONB,               -- specific risk signals (e.g. ["no_data_model", "external_dependency_undefined"])
  -- Metadata
  gap_density DECIMAL,            -- gaps / requirement_items (raw ratio)
  breakdown JSONB,                -- full breakdown (see Scoring)
  scored_at TIMESTAMPTZ
)

-- AI usage tracking
ai_usage_log (
  id,
  requirement_id UUID,
  pipeline_step TEXT,       -- parse | detect_gaps | generate_questions | validate_answer | ...
  provider TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  latency_ms INTEGER,
  retry_count INTEGER,
  created_at
)

-- Knowledge layer: high-fidelity resolved cases
knowledge_cases (
  id,
  project_id UUID,
  requirement_item_snapshot JSONB,  -- exact requirement context at time of resolution
  gap_snapshot JSONB,               -- exact gap as detected
  resolution_snapshot JSONB,        -- the decision_log entry that resolved it
  context_tags TEXT[],              -- e.g. ["saas", "api", "high-load"] for scoping retrieval
  embedding VECTOR(1536),           -- embed(gap description + requirement description)
  created_at
)

-- Feedback on knowledge case usefulness
case_feedback (
  id,
  case_id UUID REFERENCES knowledge_cases(id),
  user_id UUID,
  helpful BOOLEAN,
  used BOOLEAN,             -- user applied the suggested resolution
  overridden BOOLEAN,       -- user chose a different resolution
  created_at
)
```

**Removed from v1:**
- `gap_patterns` — replaced by `knowledge_cases`
- `resolution_patterns` — resolved into `knowledge_cases.resolution_snapshot`
- `domain_templates` — replaced by domain rule packs in `lib/requirements/rules/`

**Two logs, distinct purposes:**

| | `audit_log` | `decision_log` |
|---|---|---|
| Answers | *What changed?* | *Why was this decided?* |
| Written by | System (automatic) | User (explicit) |
| Structure | entity + diff | decision + rationale |
| Required | Always | When a decision is made |

---

## Status Gate

The `requirements.status` field is a controlled state machine. Transitions are enforced server-side.

```
draft → analyzing → incomplete | review_required
                                      ↓
                              ready_for_dev
                                      ↑
               (blocked if validated critical gaps exist without resolution or acceptance)
```

**States:**

| Status | Meaning |
|---|---|
| `draft` | User is entering raw input, no analysis run yet |
| `analyzing` | Pipeline is running |
| `incomplete` | Analysis complete; validated critical gaps exist |
| `review_required` | Analysis complete; no validated critical gaps, but validated major/minor gaps remain |
| `ready_for_dev` | No unresolved validated critical or major gaps; all others resolved or accepted |
| `blocked` | Manually blocked by a user with a reason |

**What counts toward the gate:**

Only **validated** gaps affect the status gate. AI-suggested gaps that have not been validated by a human do not block progression. This is the core epistemic separation.

Unvalidated gaps are shown in the UI with a "Needs review" badge and a validate/dismiss action. They do not count in `blocking_count` or `high_risk_count` until validated.

**Risk acceptance:**

A critical gap can be explicitly accepted instead of resolved:
- User creates a `risk_acceptances` row with mandatory `rationale`
- The gap's `resolution_source` is set to `risk_accepted`
- The acceptance is displayed prominently in the UI (not hidden)
- Acceptances can have an `expires_at` — expired acceptances reactivate the gap in the gate

**Transition rules:**

```
draft            → analyzing         always allowed (triggers pipeline)
analyzing        → incomplete        if any validated critical gap exists
analyzing        → review_required   if no validated critical gaps but validated major/minor exist
analyzing        → ready_for_dev     if no validated unresolved gaps
incomplete       → review_required   only if all validated critical gaps are resolved or accepted
review_required  → ready_for_dev     only if all validated major gaps are resolved, accepted, or dismissed with rationale
any              → blocked           any user with write access
blocked          → previous status   only the user who set blocked, or a project admin
```

**Enforcement:**
- `PATCH /api/requirements/[id]/status` validates the transition server-side, returns `409` if blocked
- UI disables "Mark ready for dev" and shows exactly which validated gaps are blocking
- Every status transition is recorded in `audit_log`
- `incomplete` status is visually distinct (red border, lock icon)

---

## Core Processing Pipeline

Triggered by `POST /api/requirements/analyze`. Each step is independently committed and writes to `audit_log`.

### Steps

**1. Parse & Structure**
- AI reads raw input
- Extracts discrete requirement items
- Classifies each: functional / non-functional / constraint / assumption
- Detects domain: saas | fintech | workflow | general (used to select rule pack)
- Links each item back to source text
- Response schema: `{ domain: string, items: Array<{ type, title, description, priority, source_text, nfr_category? }> }`

**2. Relationship Detection**

Before gap detection, relationships between requirement items are identified:

- AI analyzes items for `depends_on`, `conflicts_with`, and `refines` relationships
- Each detected relationship is stored in `requirement_relations`
- Conflicting relationships feed directly into gap detection (Layer A fires a `conflicting` gap for each `conflicts_with` relation)
- Response schema: `{ relations: Array<{ source_id, target_id, type }> }`

**3. Gap Detection** *(hybrid: rules + AI + relation conflicts)*

Gap detection runs in three layers. All three produce the same `Gap` shape and are merged before step 4.

**Layer A — Rule-based checks (deterministic)**

Pure functions over the structured items array. A fired rule always produces a gap with fixed severity and description. No AI. Independently unit-testable.

Rules are organized into **packs** selected by detected domain:

*Core pack (always active):*

| Rule | Check | Severity |
|---|---|---|
| `hasApprovalRole` | At least one item defines who approves or signs off | `critical` |
| `hasWorkflowStates` | At least one item defines system states or status transitions | `critical` |
| `hasNonFunctionalRequirements` | At least one item is classified as `non-functional` | `major` |
| `hasErrorHandling` | At least one item addresses failure or exception behaviour | `major` |
| `hasActorsDefined` | At least one item names a user role or system actor | `critical` |
| `hasDataModelDefined` | At least one item describes data entities or data structures | `major` |
| `hasInputOutputContracts` | At least one item defines inputs, outputs, or API contracts | `major` |
| `hasEdgeCasesCovered` | At least one item addresses boundary or edge-case behaviour | `minor` |
| `hasPermissionsMatrix` | At least one item defines access control or permissions | `major` |
| `hasExternalDependenciesDefined` | Any mentioned external system has at least one item describing its contract | `major` |

*SaaS pack (active when `domain = saas`):*

| Rule | Check | Severity |
|---|---|---|
| `hasBillingDefined` | At least one item addresses billing, pricing, or subscription | `critical` |
| `hasMultiTenancyAddressed` | Items do not assume single-tenant without declaring it | `major` |
| `hasAuthStrategyDefined` | At least one item defines authentication and session handling | `critical` |

*Fintech pack (active when `domain = fintech`):*

| Rule | Check | Severity |
|---|---|---|
| `hasComplianceRequirements` | At least one item addresses regulatory or compliance requirements | `critical` |
| `hasAuditTrailDefined` | At least one item defines an audit or transaction trail | `critical` |
| `hasReconciliationDefined` | At least one item addresses reconciliation or balance checks | `major` |

*Workflow pack (active when `domain = workflow`):*

| Rule | Check | Severity |
|---|---|---|
| `hasRollbackDefined` | At least one item defines rollback or compensation for failed transitions | `major` |
| `hasIdempotencyAddressed` | At least one item addresses duplicate handling or idempotency | `major` |
| `hasRetryStrategyDefined` | At least one item defines retry behaviour for failures | `major` |

**Layer B — AI analysis (contextual)**

- AI analyzes the full structured items list for gaps requiring reasoning: ambiguity, implicit conflicts, domain-specific omissions
- Response schema: `{ gaps: Array<{ item_id?, severity, category, description }> }`
- AI gaps enter with `validated: false` — they are suggestions until a human acts on them

**Layer C — Relation conflicts**

- Each `conflicts_with` relation from step 2 generates a `conflicting` gap at `critical` severity
- Source tagged as `relation`
- These gaps are validated by default (the conflict is structurally detected, not inferred)

**Gap source → validation default:**

| Source | `validated` default | Rationale |
|---|---|---|
| `rule` | `true` | Deterministic check; validation implicit |
| `relation` | `true` | Structural conflict; validation implicit |
| `ai` | `false` | Suggestion; requires human confirmation |

**4. Gap Prioritization** *(runs before question generation)*

Priority score formula (unchanged):
```
priority = impact × uncertainty

impact:      critical=3, major=2, minor=1
uncertainty: missing=3, ambiguous=2, conflicting=2, incomplete=1
```

**Question generation selection:**

- **All validated critical gaps** always receive a question, regardless of count
- Remaining question slots (up to a total of 10) are filled by highest-priority non-critical gaps
- Hard cutoff never hides a validated critical gap

```
selected = all_validated_critical + top_remaining_by_priority_score (until total = 10)
```

Ungrouped gaps without a question have a "Generate question" button (on-demand).

**Grouping similar gaps:** same-category, same-item gaps are merged. Highest-severity kept; others stored with `merged_into`.

**5. Question Generation**

- One AI call per selected gap, run in parallel
- Each call receives gap + linked requirement item + top 3 similar knowledge cases (from retrieval)
- Similar cases shown as a hint: *"Similar past case: 'API retry undefined' → resolved with exponential backoff (3 projects)"*
- Response schema per call: `{ question_text: string, target_role: "ba" | "architect" | "po" | "dev" }`
- Role assignment logic (unchanged from v1)

**6. Investigation Task Creation**

- Validated critical and major gaps automatically produce investigation tasks
- Unvalidated gaps do not produce tasks until validated

**7. Completeness Scoring**

Produces primary signals (shown in UI) and a secondary internal score.

---

**Primary signals (displayed prominently):**

```
blocking_count  = count of validated, unresolved critical gaps with no active risk_acceptance
high_risk_count = count of validated, unresolved major gaps
coverage_pct    = (requirement_areas_covered / expected_areas_for_domain) × 100
```

`coverage_pct` compares structured items against the expected requirement areas for the detected domain. A SaaS document with no billing, auth, or tenancy items has low coverage even if gap count is low.

---

**Secondary internal score (not shown as primary metric):**

Density-normalized to prevent gaming by volume:

```
gap_density     = total_validated_gaps / requirement_item_count
weighted_raw    = (critical × 20) + (major × 10) + (minor × 3)
weighted_score  = max(0, 100 - weighted_raw × (1 + gap_density))
nfr_score       = sum of covered NFR categories (security: 34, performance: 33, auditability: 33)
internal_score  = round((weighted_score × 0.7) + (nfr_score × 0.3))
```

The density multiplier penalizes documents where gaps are concentrated (many gaps in few requirements). A document with 5 gaps across 50 items scores better than 5 gaps in 5 items.

---

**Risk signals:**

```
complexity_score = AI estimate of delivery complexity (0–100, single call, async)
risk_flags       = array of named risk signals detected in requirements
```

Risk flags are named conditions, not numeric scores. Examples:

| Flag | Condition |
|---|---|
| `no_data_model` | No data entities defined |
| `external_dependency_undefined` | External system mentioned with no contract |
| `no_rollback_defined` | State transitions without rollback |
| `compliance_risk` | Domain = fintech with no compliance items |
| `auth_undefined` | No auth strategy in user-facing system |

---

**Stored breakdown JSONB:**
```json
{
  "blocking_count": 2,
  "high_risk_count": 4,
  "coverage_pct": 71,
  "internal_score": 58,
  "nfr_score": 67,
  "gap_density": 0.18,
  "complexity_score": 72,
  "risk_flags": ["no_data_model", "external_dependency_undefined"],
  "gap_counts": { "critical": 2, "major": 4, "minor": 3, "unvalidated": 5 },
  "nfr_coverage": { "security": true, "performance": true, "auditability": false }
}
```

---

### Failure Handling

- Each step is independently committed — if gap detection fails, structured items still save
- Failures write to `audit_log`
- Users see a "partial analysis" state with a per-step retry button
- AI errors surface the specific failed step with a structured error type — never a generic error
- `AIProviderError` includes: `step`, `provider`, `attemptCount`, `lastError`

---

## Partial Re-Evaluation

The full pipeline runs on initial analysis and on explicit "Re-analyze" trigger. After that, answering a question triggers targeted re-analysis on the affected requirement item.

### Trigger: Question Answered

`PATCH /api/questions/[id]` with `answer`:

1. AI evaluates whether the answer resolves the linked gap
   - Returns `{ resolved: boolean, rationale: string, new_gaps?: Gap[] }`
   - If `new_gaps` is non-empty, targeted re-analysis detected new issues introduced by the answer
2. If resolved: gap is marked `resolved_at = now`, `resolution_source = "question_answered"`
3. **If new gaps found:** they are written with `source: "ai"`, `validated: false` (surfaced as "New gap from answer" with a badge)
4. Score and status gate recalculated (deterministic, no AI)
5. New completeness_scores row written; pushed via Supabase Realtime

### Trigger: Investigation Task Resolved

`PATCH /api/investigation-tasks/[id]` with `status = resolved`:

- Linked gap marked resolved (no AI call)
- No new gap generation (task resolution is a human confirmation, not new information)
- Score recalculated

### Trigger: Gap Validated / Dismissed

`PATCH /api/gaps/[id]` with `validated = true` or `dismissed`:

- Validated gaps count toward the status gate from this point
- Dismissed gaps are stored with `resolved_at` set and `resolution_source = "dismissed"`, removed from active counts
- Score and gate recalculated

### What Re-Evaluation Does NOT Do

- Re-run gap detection on the full document (requires explicit "Re-analyze")
- Re-rank questions (priority order is frozen at analysis time)

---

## UI — Requirements Workspace

Three tabbed views at `projects/[id]/requirements/`:

### Risk Summary Panel (persistent, above all tabs)

Primary signal. Always visible regardless of active tab.

```
┌──────────────────────────────────────────────────────────────────┐
│  ⛔ 2 blocking issues    ⚠️ 4 high-risk areas    📊 71% coverage  │
│  5 unvalidated gaps need review    ⛔ NOT READY FOR DEVELOPMENT   │
└──────────────────────────────────────────────────────────────────┘
```

**The numeric internal score is not shown here.** It is accessible via the score breakdown popover (click coverage%).

**States:**

| Condition | Verdict display |
|---|---|
| `status = ready_for_dev` | ✅ READY FOR DEVELOPMENT |
| `status = review_required` | ⚠️ REVIEW REQUIRED |
| `status = incomplete` | ⛔ NOT READY — [N] BLOCKING ISSUES |
| `status = blocked` | 🔒 BLOCKED — [reason] |
| `status = analyzing` | ⏳ ANALYZING… |

- "blocking issues" and "high-risk areas" are links → View 3 filtered to that severity
- "coverage%" is a link → score breakdown popover (internal score, NFR coverage, risk flags, complexity)
- Risk flags shown as inline badges if any are set
- Panel updates in real time via Supabase Realtime

**API:** `GET /api/requirements/[id]/summary`
```typescript
{
  blocking_count: number
  high_risk_count: number
  coverage_pct: number
  unvalidated_count: number     // gaps awaiting human review
  internal_score: number        // secondary, shown in popover only
  complexity_score: number
  risk_flags: string[]
  status: RequirementStatus
  blocked_reason: string | null
}
```

### View 1: Input

- Textarea for raw requirements
- "Analyze" button triggers pipeline
- Real-time status bar (pipeline step progress via Supabase Realtime)
- After analysis: automatically navigate to View 2

### View 2: Structured Requirements

- Requirement items grouped by type
- Each item shows: title, source snippet, attached gaps (severity badge), relationships (dependency/conflict badges)
- Relationship graph: items with `conflicts_with` relations shown with a red conflict badge linking to the other item
- "Mark ready for dev" button: disabled with tooltip listing blocking validated gaps; enabled only when gate is clear
- Last-write-wins for concurrent edits in MVP

### View 3: Gaps & Questions

- Default: validated gaps with questions, sorted by priority score
- "Show unvalidated" toggle: reveals AI-suggested gaps awaiting review — each has "Validate" / "Dismiss" actions
- Unvalidated gaps are visually distinct (dashed border, "AI suggestion" label)
- Each validated gap with a question expands to show:
  - Clarifying question + target role badge
  - Inline answer input
  - Similar past case hint (if knowledge retrieval found one)
  - "Record Decision" action: two-field form (decision + rationale, both required) → `decision_log`
  - Linked investigation task with status badge
  - "Accept risk" action on critical gaps: opens rationale field + optional expiry → `risk_acceptances`
- Each gap without a question: "Generate question" button
- Merged gaps: collapsed under representative gap with count badge ("+ 2 similar")
- New gaps from partial re-evaluation shown with "New — from answer" badge

---

## Knowledge Layer

The knowledge layer stores memory, not abstractions. No LLM summarization. No auto-generalized patterns.

### Mental Model

> The system remembers **situations**, not rules. Rules come from data, not from upfront design.

### How Cases Are Written

When a gap is resolved (any `resolution_source`):

1. A `knowledge_cases` row is created with:
   - `requirement_item_snapshot`: the full requirement item at resolution time
   - `gap_snapshot`: the full gap record
   - `resolution_snapshot`: the `decision_log` entry
   - `context_tags`: derived from `requirements.domain` + any NFR categories present
2. An embedding is generated: `embed(gap.description + " " + requirement_item.description)`
3. The embedding is stored in `knowledge_cases.embedding`

This is async — does not block the user.

### How Cases Are Retrieved

Before question generation (step 5 in pipeline):

For each gap selected for question generation:
1. Embed the gap description + requirement item description
2. Query `knowledge_cases` for top 5 nearest neighbors (cosine similarity via pgvector)
3. Filter by `context_tags` overlap — cases from unrelated domains are excluded
4. Return up to 3 cases with positive `case_feedback.helpful` signal (or cases with no feedback yet, in absence of signal)

Result shown to user in View 3 as: *"Similar past case: '[gap description]' → '[resolution summary]' (used in [N] projects)"*

### Feedback Loop

After a case is shown:

- If the user applies the suggested resolution → `case_feedback(helpful=true, used=true)`
- If the user overrides it → `case_feedback(helpful=true, used=false, overridden=true)`
- If the user ignores it → no feedback written (silence ≠ negative signal)
- Explicit "Not helpful" action → `case_feedback(helpful=false)`

Cases with consistent `helpful=false` are deprioritized in retrieval (not deleted — audit trail).

### When to Abstract

Abstraction is deferred until real data exists. Once 50–100 cases accumulate:
- Cluster by embedding similarity
- Review clusters manually (or with AI assistance)
- Promote clusters to named rule additions or domain template areas

This is a Phase 2 activity. Phase 1 only stores and retrieves.

### What Was Removed

- `gap_patterns` table
- `resolution_patterns` table
- LLM-based description_template generalization
- Auto-global promotion by occurrence_count
- Naive "matching gap exists" string comparison

---

## Requirement Relationships

Flat requirement lists miss cross-item issues. Relationships make conflicts visible.

### Detection

After parsing (step 2 in pipeline), a dedicated AI call analyzes all items for relationships:

- `depends_on`: item A requires item B to be implemented first
- `conflicts_with`: items A and B express contradictory requirements
- `refines`: item A adds detail or constraints to item B

Response schema: `{ relations: Array<{ source_id, target_id, type }> }`

### How Relationships Feed Into Gap Detection

- Every `conflicts_with` relation automatically generates a `conflicting` gap at `critical` severity (Layer C)
- `depends_on` relations where the dependency has unresolved critical gaps bubble up as a `major` gap on the dependent item

### UI

- In View 2, items with relationships show relationship badges
- "Conflicts with [item title]" badge links to the other item
- "Depends on [item title]" badge indicates execution order sensitivity

---

## Error Handling

- Pipeline failures are partial — users see what succeeded, not a blank error
- All errors recorded in `audit_log`
- AI provider errors: structured `AIProviderError` with step, provider, attempt count
- No silent failures — every error state is visible in the UI
- Retry buttons per failed step

---

## Testing Strategy

| Layer | Approach |
|---|---|
| Unit (rules) | Each rule function tested independently with fixture item arrays — zero AI calls, fully deterministic |
| Unit (domain) | `parser`, `scorer`, `gap-detector`, `relation-detector`, `risk-predictor` with mock rule results + mock AI responses |
| Integration | Full pipeline API route with test Supabase instance + mock AI provider returning fixture JSON |
| E2E | Playwright: submit input → structured output → gaps view → validate gap → answer question → score updates |

**New test coverage required (beyond v1):**

- Gap validation flow: AI gap unvalidated → user validates → gate updates
- Risk acceptance flow: critical gap + rationale → gate clears
- Partial re-evaluation creates new gaps when answer introduces new issues
- Relation detection produces `conflicts_with` gap
- Knowledge case written and retrieved correctly (embedding similarity)
- AI provider: retry on failure, JSON auto-repair, fallback provider

---

## What's Out of Scope for Phase 1

- File upload (PDF, DOCX) — textarea input only
- Real-time collaborative editing — last-write-wins for now
- Manual knowledge case abstraction / clustering (Phase 2)
- Completeness validation against external standards (Phase 2)
- Test case generation (Phase 3)
- Ticket/issue generation (Phase 4)
- Agent-driven automation (Phase 5)
- Integration with Jira, GitHub, Confluence (Phase 4)
- Role-based access control beyond basic auth
- Cross-tenant knowledge sharing

---

## Success Criteria

Phase 1 is complete when:

1. A user can paste raw text requirements and receive structured items with source traceability
2. Gaps are detected from three sources: rules (deterministic), AI (suggested), relation conflicts (structural)
3. AI-sourced gaps require human validation before affecting the status gate
4. Critical gaps block progression unless resolved OR explicitly accepted with a rationale
5. Every critical gap always receives a clarifying question (no cutoff suppresses critical gaps)
6. Partial re-evaluation can surface new gaps when a question answer introduces new issues
7. The primary UI signal is blocking count / high-risk count / coverage% — not a numeric score
8. The internal numeric score exists but is accessible only via the score breakdown popover
9. Resolved gaps are stored as high-fidelity knowledge cases with embeddings; similar past cases surface during question generation
10. Requirement relationships are detected; `conflicts_with` relations automatically generate critical gaps
11. Risk flags are computed and displayed in the summary panel
12. AI provider can be swapped by changing `AI_PROVIDER` env var with no code changes
13. AI calls include retry, timeout, JSON auto-repair, and cost logging
14. Every mutation is recorded in `audit_log`; every resolved gap can have a `decision_log` entry with both `decision` and `rationale`
