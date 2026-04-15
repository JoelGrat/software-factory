# Planning Refactor — Design Spec

**Date:** 2026-04-15
**Status:** Approved

---

## Problem

The current planning system is half-human. It generates flat task descriptions (plain strings with a component association) and a spec as an afterthought after the plan. The impact analysis is seeded by keyword guessing, not declared intent. The executor consumes tasks it cannot reason about. There are no substeps, no file targets, no validation commands, no dependency links — only strings.

This is not an executable plan. It is a roadmap. A roadmap cannot drive a machine.

---

## Goals

- Replace the flat task model with a structured execution model: phases → tasks → substeps
- Invert the pipeline order: spec first, then plan derived from spec, then everything else derived from plan
- Re-center impact analysis on plan-declared intent rather than keyword inference
- Make artifact contracts machine-enforced at every stage boundary
- Add explicit failure semantics with retry-from-stage support
- Derive the human task view as a projection from the machine plan, not as an independent artifact

---

## Architecture

### Pipeline Flow

```
validated
  ↓
planning
  ├─ Stage 1: generateSpec()
  │    internally: inferCandidateComponents → inferLikelyFiles
  │                → deriveAssumptions → loadProjectContext
  │                → generateCanonicalSpec
  │    output: change_specs row (markdown + structured_json)
  │
  ├─ Stage 2: generateDetailedPlan()
  │    input: spec.structured
  │    output: plan_json written to change_plans
  │    gate: reject if any task lacks substeps / actionable target / validation
  │
  ├─ Stage 3: projectHumanTaskView()
  │    input: plan_json
  │    output: change_plan_tasks rows (projection — delete + rebuild on change)
  │
  ├─ Stage 4: runImpactAnalysis()
  │    seeds: plan_json file targets + substep targets + migrations + commands
  │    traversal: component graph expansion from seeds, decay-weighted by distance
  │    output: change_impacts + change_impact_components + drift ratio
  │
  ├─ Stage 5: scoreRisk()
  │    signals: task count, substep count, migration presence, drift ratio,
  │             critical system coverage, validation density
  │    output: risk_level on change_requests
  │
  └─ Stage 6: applyExecutionPolicy()
       precedence (explicit, no hidden branching):
         plan invalid              → failed (not policy)
         quality_score < 0.5      → approval
         risk = low               → auto
         risk = medium            → approval
         risk = high              → manual
  ↓
ready | awaiting_approval | executing
```

### Failure Semantics

Every stage has an explicit failure exit:

```
planning → failed {
  stage: string       // which stage failed
  retryable: boolean  // true = resume from this stage
  reason: string      // one-line summary
  diagnostics: {
    summary: string
    issues: string[]  // first 10 only
    truncated: boolean
  }
  failed_at: string   // ISO timestamp
}
```

**Retry rule:** `retryable: true` resumes from the failed stage using artifacts persisted by prior stages. A new `planner_version` is cut on retry — failed attempt artifacts are preserved, not overwritten.

### Status Model

| Layer | Values |
|---|---|
| Public (`change_requests.status`) | `validated`, `planning`, `ready`, `awaiting_approval`, `executing`, `review`, `failed` |
| Internal (`change_plans.current_stage`) | `spec`, `plan`, `projection`, `impact`, `risk`, `policy` |

External consumers (UI, API) only see the public status. Internal stage tracking lives on the plan artifact.

---

## Data Model

### New Table: `change_specs`

```sql
id           uuid pk
change_id    uuid fk → change_requests
version      int not null default 1
markdown     text                    -- human-readable contract
structured   jsonb not null          -- ChangeSpec shape (see Interfaces)
created_at   timestamptz
```

One row per planning run. Version increments on retry.

### Modified: `change_plans`

```
ADD:  plan_json        jsonb          -- full DetailedPlan (see Interfaces)
ADD:  version         int default 1
ADD:  current_stage   text           -- internal stage tracker
ADD:  stage_durations jsonb          -- { spec: 1200, plan: 3400, ... } ms
ADD:  failed_stage    text
ADD:  planner_version int default 1
ADD:  started_at      timestamptz
ADD:  ended_at        timestamptz

DROP: spec_markdown    -- moved to change_specs
DROP: estimated_files  -- derived from plan_json phases[].tasks[].files[]
KEEP: branch_name, plan_quality_score, status, created_at, updated_at
```

### Modified: `change_plan_tasks` (projection table)

```
ADD:  plan_task_id   text    -- id from plan_json
ADD:  phase_id       text    -- phase id from plan_json
ADD:  plan_version   int
KEEP: description, order_index, status, component_id, new_file_path
```

Rows are projections from `plan_json`. When `plan_json` changes, all rows for that plan are deleted and rebuilt from scratch. Never patched incrementally.

### Modified: `change_requests`

```
ADD:  retryable              boolean
ADD:  failure_diagnostics    jsonb   -- bounded failure shape above
DROP: draft_plan             jsonb   -- replaced by change_specs
KEEP: pipeline_status, failed_stage, input_hash, phase_timings
```

`pipeline_status` values: `spec_generating → spec_generated → plan_generating → plan_generated → impact_analyzing → impact_analyzed → scoring → scored → [policy applied]` + `failed`.

---

## Key Interfaces

```typescript
// Stored in change_specs.structured
interface ChangeSpec {
  problem: string
  goals: string[]
  architecture: string
  constraints: string[]
  data_model?: string
  ui_behavior?: string
  policies?: string[]
  out_of_scope: string[]
}

// Stored in change_plans.plan_json
interface DetailedPlan {
  schema_version: 1
  planner_version: number
  goal: string
  // branch_name lives as a top-level column on change_plans — not mirrored here
  phases: Phase[]
}

interface Phase {
  id: string           // e.g. "phase_1"
  title: string
  depends_on: string[] // phase ids
  tasks: Task[]
}

interface Task {
  id: string
  title: string
  description?: string  // optional long-form for UI and human review
  type: 'backend' | 'frontend' | 'database' | 'testing' | 'infra' | 'api' | 'refactor'
  files: string[]
  depends_on: string[]  // task ids within the plan
  substeps: Substep[]   // execute in array order; future scheduler may override
  validation: ValidationCheck[]
  expected_result: string
  retryable?: boolean
  parallelizable?: boolean  // task may run alongside others with no shared state;
                            // does NOT affect substep ordering within the task
}

interface Substep {
  id: string
  action: 'write_file' | 'modify_file' | 'run_command' | 'verify_schema' | 'run_test' | 'insert_row'
  target?: string    // file path or schema name
  command?: string
  expected?: string[]
}

type ValidationCheck =
  | { type: 'command';     command: string; success_contains?: string }
  | { type: 'file_exists'; target: string }
  | { type: 'schema';      table: string;   expected_columns?: string[] }
  | { type: 'test_pass';   pattern?: string }
```

---

## Impact Analysis

### New Seed Model

Old approach: `title → keyword match → graph`
New approach: `plan_json → explicit seeds → graph expansion`

**Seed extraction order (from `plan_json`):**
1. Explicit file paths in task `files[]`
2. Substep `target` values
3. Substep `command` values (detect migrations, build commands)
4. Module names from task titles + descriptions
5. Fallback keyword inference only when seeds are empty (rare)

### Graph Traversal

Seeds enter the existing `system_components` graph. Traversal expands outward:
- Direct imports from changed files
- Reverse imports (who depends on changed files)
- Component ownership mapping
- Related tests
- Shared schemas / types

**Decay weighting by traversal distance:**

| Source | Weight |
|---|---|
| Explicitly modified in plan | 1.0 |
| File created by plan | 0.8 |
| Direct dependent | 0.7 |
| Second-order dependency | 0.5 |
| Distant propagation | 0.3 |

Components tagged `auth`, `db`, `execution-core`, `billing`, or `deployment` receive a risk boost regardless of distance.

### Drift Ratio

`drift_ratio = indirect_impact_count / direct_seed_count`

A high drift ratio signals the planner underestimated complexity. Feeds into risk scoring.

---

## Quality Gate Rules

`plan-validator.ts` enforces these at plan exit, before persistence.

**Reject if any task:**
- Has `substeps.length === 0`
- Has no actionable target: `files` empty AND no substep has `command` or `target`
- Has `validation.length === 0`
- Has `expected_result` empty or missing
- Has a `depends_on` entry that doesn't resolve to a real task id
- Creates a circular dependency

**Reject if the plan:**
- Has `phases.length === 0`
- Has any phase with `tasks.length === 0`
- Is missing `branch_name`

**On rejection:** retry once with an enrichment prompt that includes the specific gate failures. If retry also fails → `failed { stage: 'plan', retryable: false, reason: 'quality_gate' }`.

Quality score (`plan_quality_score`) is computed after gates pass. Gates are binary pass/fail. Score is a continuous signal used only at the policy stage.

---

## Policies

- **No duplicate semantics:** `branch_name` in the column is canonical; `plan_json` does not mirror it.
- **Projection freshness:** `change_plan_tasks` rows are always rebuilt from scratch when `plan_json` changes. Incremental patching is prohibited.
- **Repository isolation:** `planning-repository.ts` is the only file that reads or writes Supabase. Generators produce plain objects. The orchestrator calls generators, validates contracts, then calls the repository.
- **Failure diagnostics are bounded:** max 10 issues, `truncated: true` flag when more exist. No raw stack traces.

---

## Out of Scope

- Execution pipeline consuming `plan_json` — this is a follow-up refactor
- UI changes to display phases/substeps — follow-up
- Parallel substep scheduling — `parallelizable` flag is reserved for future use
- Planner cost/token tracking — `stage_durations` is added; token counts are not

---

## File Map

### Delete
```
lib/pipeline/phases/draft-plan.ts
lib/planning/draft-planner.ts
lib/planning/phases.ts
lib/planning/prompt-builders.ts
lib/planning/task-validator.ts
lib/planning/add-task.ts
```

### Rewrite
```
lib/pipeline/orchestrator.ts
lib/pipeline/phases/impact-engine.ts     (was impact-analysis.ts)
lib/planning/types.ts
```

### New
```
lib/planning/spec-generator.ts           -- generateSpec() + internal helpers
lib/planning/detailed-plan-generator.ts  -- generateDetailedPlan() + quality gates
lib/planning/plan-validator.ts           -- artifact contract enforcement
lib/planning/human-task-view.ts          -- projectToTasks()
lib/planning/impact-seeder.ts            -- extractPlanSeeds()
lib/planning/risk-scorer.ts              -- scoreFromPlan()
lib/planning/planning-repository.ts      -- all DB reads/writes
```

### Tests
```
tests/planning/spec-generator.test.ts
tests/planning/plan-validator.test.ts
tests/planning/human-task-view.test.ts
tests/planning/risk-scorer.test.ts
tests/pipeline/orchestrator.test.ts
```

### Migration
```
supabase/migrations/025_planning_refactor.sql
```
