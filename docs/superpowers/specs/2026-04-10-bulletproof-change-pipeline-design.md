# Bulletproof Change Pipeline — Design Spec

**Date:** 2026-04-10  
**Status:** Approved  
**Scope:** Phases 0–3 of the change request pipeline (validation → draft plan → impact analysis → plan generation)

---

## Overview

The current pipeline has four structural problems:

1. **No vagueness gate** — garbage input flows straight into AI calls, producing garbage plans
2. **Draft plan runs twice** (or zero times before impact analysis) — no single source of truth for initial AI inference
3. **Hardcoded BFS decay weights** — cannot be tuned per project, cannot be learned over time
4. **No task validation** — AI-generated tasks are inserted as-is with no structural verification

This design fixes all four with a phased, modular, idempotent pipeline.

---

## Architecture

### Pipeline structure

```
POST /change-requests
  → validateChangeRequest(body)         # Phase 0 — sync, at API boundary
  → insert change_requests row
  → runPhase('draftPlan', changeId)     # Phase 1
  → runPhase('impactAnalysis', changeId) # Phase 2
  → runPhase('planGeneration', changeId) # Phase 3
  → apply execution policy
```

### Phase contracts

Each phase in `lib/pipeline/phases/` follows this contract:

- **Reads** its inputs from DB (or passed directly by orchestrator)
- **Validates** preconditions — fails fast if inputs are missing, stale, or malformed
- **Writes** outputs transactionally — new data written and committed before old data removed
- **Is idempotent** — safe to re-run; re-running produces the same result, never duplicates rows
- **Records timings** — `started_at` before first operation, `completed_at` after last write
- **Fails independently** — sets `failed_phase` and `pipeline_status` on error, leaves previous valid state intact
- **Transitions status atomically** — every `pipeline_status` update uses a guarded UPDATE:
  ```sql
  UPDATE change_requests
  SET pipeline_status = '<next_state>'
  WHERE id = $1 AND pipeline_status = '<expected_current_state>'
  ```
  If `rows_affected === 0` → abort phase immediately. Prevents concurrent execution and double-run corruption.
- **Tags writes with `pipeline_run_id`** — every DB row written by a phase includes the current `pipeline_run_id`. Reads always use the latest `pipeline_run_id`. Prevents partial reads between delete and insert, and enables clean re-runs without corrupting prior state.

### Orchestrator (`lib/pipeline/orchestrator.ts`)

Thin. Does only:

- Phase sequencing
- Status transitions
- Drift checks (input hash)
- Error handling

No business logic. If logic leaks into the orchestrator, it belongs in a phase module.

### Phase registry

```
lib/pipeline/phases/
  draft-plan.ts          → runDraftPlanPhase(changeId, db, ai)
  impact-analysis.ts     → runImpactAnalysisPhase(changeId, db, ai)
  plan-generation.ts     → runPlanGenerationPhase(changeId, db, ai)
```

Existing `lib/impact/` and `lib/planning/` modules are **not moved** — they become the implementation called by phase wrappers.

---

## Data Model

### New columns on `change_requests`

| Column | Type | Purpose |
|---|---|---|
| `input_hash` | `text` | SHA-256 of `title + '\|' + intent + '\|' + type` — drift detection |
| `draft_plan` | `jsonb` | Full draft plan output + metadata |
| `pipeline_status` | `text` | **New column alongside existing `status`** — tracks pipeline phase granularly (see states below). Existing `status` column retained for UI/external consumers; `pipeline_status` is the internal pipeline truth. |
| `failed_phase` | `text` | Set when a phase fails — enables re-run from that point |
| `phase_timings` | `jsonb` | Per-phase `{ started_at, completed_at, duration_ms }` |
| `pipeline_run_id` | `uuid` | Generated fresh each time the pipeline starts (or re-starts). All phase outputs written with this ID. Latest run_id is the authoritative state. |

### `pipeline_status` valid states

```
open
→ validated
→ draft_planned
→ impact_analyzed
→ plan_generated
→ awaiting_approval
→ ready_for_execution
→ failed_at_draft_plan
→ failed_at_impact_analysis
→ failed_at_plan_generation
```

### `draft_plan` JSONB shape

```json
{
  "new_file_paths": ["relative/path/to/file.ts"],
  "component_names": ["ComponentName"],
  "assumptions": ["Assumes AuthService is the entry point"],
  "confidence": 0.82,
  "created_at": "2026-04-10T...",
  "model_version": "claude-sonnet-4-6",
  "prompt_version": "draft-plan-v1",
  "draft_plan_version": 1,
  "input_hash": "abc123..."
}
```

`input_hash` embedded in the draft plan lets each downstream phase independently verify it was produced from the current input — no implicit trust.

### New column on `change_impacts`

| Column | Type | Purpose |
|---|---|---|
| `traversal_evidence` | `jsonb` | Per-component BFS path evidence (see below) |

```json
{
  "AuthService": {
    "reached_via": ["fileId1 → fileId3 → fileId7"],
    "source": "via_file",
    "depth": 2
  },
  "UserRepository": {
    "reached_via": ["direct keyword match: 'user'"],
    "source": "directly_mapped",
    "depth": 0
  }
}
```

### New columns on `change_plans`

| Column | Type | Purpose |
|---|---|---|
| `validation_log` | `jsonb` | Array of per-attempt validation results (see below) |
| `plan_quality_score` | `float` | 0.0–1.0 score (see scoring rules) |

`validation_log` shape:
```json
[
  { "attempt": 1, "passed": false, "errors": ["No test task for AuthService"], "warnings": [], "timestamp": "..." },
  { "attempt": 2, "passed": true,  "errors": [], "warnings": ["Unknown component ref: FooBar"], "timestamp": "..." }
]
```

### `project_settings.impact_decay` (new key)

```json
{
  "impact_decay": {
    "re_export": 0.8,
    "static_import": 0.7,
    "component_dependency": 0.6,
    "depth_limit": 3,
    "min_weight_threshold": 0.1
  }
}
```

Hardcoded values in `file-bfs.ts` become defaults when not set in project settings.

---

## Phase 0 — Input Validation

**Where:** `lib/change-requests/validator.ts` (extends current)  
**When:** synchronously at `POST /change-requests` API boundary, before any DB write  
**Failure:** returns 400 with structured error, no DB side effects

### Stage 1 — Deterministic gate

Reject immediately if any:

- `title.length < 10`
- `intent.length < 30`
- title or intent matches vague phrase blocklist: `["update stuff", "misc", "general improvements", "refactor code", "various fixes", "fix bugs", "cleanup", "changes", "updates"]`
- intent has fewer than 2 action verbs from: `add, update, remove, fix, implement, create, refactor, migrate, replace, delete`
- intent has neither a technical noun (`endpoint, page, form, hook, service, table, schema, component, module, route, api, button, modal`) nor a multi-word phrase (> 5 words)

### Stage 2 — Suspicion scoring + AI gate

Compute suspicion score before deciding whether to call AI. Flag as suspicious if:

- `intent.length < 60` chars
- fewer than 2 action verbs
- no technical noun match
- contains generic filler words: `"system", "feature", "thing", "part", "stuff"`

If ≥ 2 flags → call AI scoring. Else → accept.

**AI scoring prompt** (max 200 tokens):
```
Score this change request for implementation readiness.
Title: {title}
Intent: {intent}
Type: {type}

Respond with JSON: { "score": 0.0–1.0, "reason": "one sentence" }

Criteria:
- Does it name a specific thing to change?
- Is the scope clear (what is in/out)?
- Could a developer start implementing without asking questions?
```

- Threshold: **0.65** — reject if below
- AI output validated: `score` must be a number in `[0,1]`, `reason` must be a non-empty string
- If malformed → retry once; if still malformed → fail safe (reject)

### Rejection response structure

```json
{
  "error": "INVALID_CHANGE_REQUEST",
  "reasons": [
    "Intent too vague — no specific component or scope identified",
    "AI specificity score 0.42: scope is unclear"
  ],
  "suggestion": "Specify which component and what change (e.g. 'Add retry logic to AuthService login endpoint')"
}
```

### Status after passing

Set `pipeline_status = 'validated'` immediately before pipeline fires.

---

## Phase 1 — Draft Plan

**Module:** `lib/pipeline/phases/draft-plan.ts`  
**Wraps:** `lib/planning/draft-planner.ts` (extended)

### Preconditions

- `pipeline_status === 'validated'`
- `title`, `intent`, `type` all present

### AI output (max 512 tokens)

```json
{
  "new_file_paths": ["relative/path/to/file.ts"],
  "component_names": ["ComponentName"],
  "assumptions": ["Assumes AuthService is the entry point"],
  "confidence": 0.82
}
```

### Post-processing

- `confidence` clamped to `[0,1]`; defaults to `0.5` if missing; retry once if malformed
- `assumptions` defaults to `[]` if missing

### Persistence (single transaction)

1. Compute `input_hash = SHA-256(title + '|' + intent + '|' + type)`
2. Write `change_requests.draft_plan = { ...output, input_hash, created_at, model_version, prompt_version, draft_plan_version: 1 }`
3. Write `change_requests.input_hash = input_hash`
4. Set `pipeline_status = 'draft_planned'`
5. Write `phase_timings.draft_plan = { started_at, completed_at, duration_ms }`

### Idempotency

If `draft_plan` already exists and `draft_plan.input_hash === input_hash`:
- Also validate stored fields: `new_file_paths` and `component_names` are non-null arrays, `confidence` is a number in `[0,1]`
- If all valid → skip, return stored result
- If any invalid → recompute

If hash differs:
- If `pipeline_status` is `plan_generated`, `awaiting_approval`, `ready_for_execution`, or any execution state → reject with error: `"Pipeline has progressed beyond plan generation — pass force_reset: true to restart from scratch"`
- Otherwise → cascade reset (within one transaction, logged):
  - Delete `change_plan_tasks` (via cascade from `change_plans`)
  - Delete `change_plans WHERE change_id = $1`
  - Delete `change_impact_components` (via cascade from `change_impacts`)
  - Delete `change_risk_factors WHERE change_id = $1`
  - Delete `change_impacts WHERE change_id = $1`
  - Overwrite `draft_plan` and `input_hash`

### On failure

- Set `pipeline_status = 'failed_at_draft_plan'`, `failed_phase = 'draft_plan'`
- Transaction rolled back — no partial state written

---

## Phase 2 — Impact Analysis

**Module:** `lib/pipeline/phases/impact-analysis.ts`  
**Wraps:** `lib/impact/impact-analyzer.ts` (modified)

### Preconditions

- `pipeline_status === 'draft_planned'`
- `draft_plan` exists with valid fields:
  - `component_names` is a non-empty array of strings
  - `new_file_paths` is an array (may be empty)
  - `confidence` is a number in `[0,1]`
- `draft_plan.input_hash === change_requests.input_hash`

Hash mismatch → fail fast: `"Draft plan is stale — re-run draft plan phase first."`  
Content invalid → fail fast: `"Draft plan is corrupted — re-run draft plan phase."`  
In both cases: `pipeline_status = 'failed_at_impact_analysis'`, `failed_phase = 'impact_analysis'`.

### Changes from current implementation

**1. Configurable decay weights**

Load from `project_settings.impact_decay` at phase start. Fall back to current hardcoded values if not set. Pass into `runFileBFS` replacing constants.

**2. Assumptions passed as context**

`draft_plan.assumptions[]` appended to the component mapping AI prompt:
```
The draft plan makes these assumptions: {assumptions.join(', ')}
```
Stops the mapping phase from re-inferring context the draft plan already established.

**3. Traversal evidence captured**

During BFS, each file records its predecessor. After BFS completes, evidence is summarized per component and stored in `change_impacts.traversal_evidence`.

**4. Transactional writes**

All writes (delete previous + insert new `change_impacts`, `change_risk_factors`, `change_impact_components`) happen in a single transaction. Rollback on any failure — previous valid state preserved.

### Phase timings

`started_at` captured before first DB read. `completed_at` after final status update.
`phase_timings.impact_analysis = { started_at, completed_at, duration_ms }`

### On failure

`pipeline_status = 'failed_at_impact_analysis'`, `failed_phase = 'impact_analysis'`

---

## Phase 3 — Plan Generation

**Module:** `lib/pipeline/phases/plan-generation.ts`  
**Wraps:** `lib/planning/plan-generator.ts` (modified)  
**New:** `lib/planning/task-validator.ts`

### Preconditions

- `pipeline_status === 'impact_analyzed'`
- `draft_plan` exists with `draft_plan.input_hash === change_requests.input_hash`
- `change_impacts` row exists for this `change_id`

All three checked — fail fast on any missing.

### What changes from current implementation

`runDraftPlan` call removed. Phase reads `change_requests.draft_plan` from DB. Keyword augmentation stays but uses stored `component_names`.

`draft_plan.assumptions[]` appended to `buildArchitecturePrompt` as context block.

### Task validation rules (`lib/planning/task-validator.ts`)

Applied after each generation attempt:

| Rule | Failure condition |
|---|---|
| Component mapping | Task has null `componentId` AND no `newFilePath` |
| Coverage | Tasks don't cover top 3 components by weight OR components representing ≥80% of total weight |
| No empty plan | `tasks.length === 0` (hard failure at every attempt including fallback) |
| Deduplication | Two tasks share `(normalized_component_id, normalized_action_type, file_path)` — action types bucketed as `implement \| test \| verify \| create \| delete` |
| Test coverage | No task with action type `test` that references a `componentId` AND a file path containing `spec`, `test`, `.test.`, or `.spec.` |
| File existence | Task references a file not in `files` table AND not in `architecture.newFilePaths` |
| Consistency | Task references a `componentId` not in `change_impact_components` — ≤1 violation is a warning; >1 is a validation failure |

### Retry flow

**Attempt 1 — normal generation**
Generate tasks, run validator. If valid → done.

**Attempt 2 — constrained regeneration**
Append to prompt:
- All validation errors from Attempt 1
- Explicit allowed component list: `"You must only reference these components: ..."`
- Explicit allowed file list (existing + planned new files): `"You must only create or modify these files: ..."`
- Stricter JSON schema requiring `component_name` and `file_path` per task
- Explicit prohibition: `"Do not reference any component or file not listed above. Do not invent new components. If you cannot generate valid tasks within these constraints, return an empty tasks array."`

Empty tasks array returned by AI → treated as hard failure, advances to Attempt 3.

Run validator. If valid → done.

**Attempt 3 — deterministic fallback**
No AI call. Generate structured tasks directly:

```ts
interface FallbackTask {
  component_name: string
  component_id: string
  file_path: null
  action: 'implement_changes' | 'add_tests' | 'create_file'
  description: string
}
```

- One `implement_changes` task per impacted component (weight > 0.3): `"Implement changes in ${component.name} — ${architecture.componentApproaches[component.name] ?? change.intent}"`
- One `add_tests` task per impacted component: `"Add tests for ${component.name} in ${component.name.toLowerCase()}.spec.ts"`
- One `create_file` task per `architecture.newFilePaths`

If `tasks.length === 0` after fallback → `pipeline_status = 'failed_at_plan_generation'`, error: `"No tasks could be generated — change may be too vague to plan"`

### Plan quality score

Computed post-validation, stored as `change_plans.plan_quality_score`:

- Starts at `1.0`
- `-0.2` if fallback (Attempt 3) was used
- `-0.1` per retry consumed (Attempt 2 = -0.1, Attempt 3 = -0.2 total for retries)
- `-0.05` per validation warning
- `-0.15` if task coverage < 80% of total impact weight
- Floored at `0.1`

After penalties, score is capped by risk level:

| Risk level | Score cap |
|---|---|
| `low` | 1.0 |
| `medium` | 0.8 |
| `high` | 0.6 |

`final_score = min(penalized_score, risk_adjusted_cap)`

This prevents a "perfect plan" from overriding actual change risk. A high-risk change with flawless task generation still scores ≤ 0.6.

Used downstream to bias execution policy: final score < 0.5 overrides `auto` policy → requires `approval` regardless of risk level.

### Idempotency

Existing `change_plans` and `change_plan_tasks` for this `change_id` deleted and new plan inserted within a single transaction. Rollback on failure — previous plan intact.

### Validation log

Every attempt recorded in `change_plans.validation_log` (even on success):
```json
[
  { "attempt": 1, "passed": false, "errors": ["Coverage below 80% threshold"], "warnings": [], "timestamp": "..." },
  { "attempt": 2, "passed": true,  "errors": [], "warnings": ["Unknown component ref: FooBar"], "timestamp": "..." }
]
```

### Phase timings

`phase_timings.plan_generation = { started_at, completed_at, duration_ms, attempt_count }`

`attempt_count` records whether fallback was used (1, 2, or 3).

### On failure

`pipeline_status = 'failed_at_plan_generation'`, `failed_phase = 'plan_generation'`. Validation errors surfaced in `change_plans.validation_log`.

---

## What is NOT in scope

- Feedback learning for decay weights — configurable now, feedback-driven in a future phase once execution history exists
- UI changes for surfacing `plan_quality_score`, `traversal_evidence`, `validation_log` — tracked separately
- Execution phase changes — out of scope for this spec
