# Planning Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat-string task planner with a structured 6-stage pipeline: spec → detailed plan (phases/tasks/substeps) → human task view → plan-seeded impact analysis → risk scoring → execution policy.

**Architecture:** Complete rewrite of `lib/planning/` and `lib/pipeline/orchestrator.ts`. Old phases deleted entirely. New stages are isolated modules with a shared repository layer for all DB writes. Artifact contracts enforced by `plan-validator.ts` at every stage boundary.

**Tech Stack:** Next.js App Router, Supabase (PostgreSQL), TypeScript, Vitest

**Spec:** `docs/superpowers/specs/2026-04-15-planning-refactor-design.md`

---

## File Map

### Delete (after all new code is wired up — Task 12)
- `lib/pipeline/phases/draft-plan.ts`
- `lib/pipeline/phases/impact-analysis.ts` ← replaced by `impact-engine.ts`
- `lib/pipeline/phases/plan-generation.ts`
- `lib/planning/draft-planner.ts`
- `lib/planning/phases.ts`
- `lib/planning/prompt-builders.ts`
- `lib/planning/task-validator.ts`
- `lib/planning/add-task.ts`
- `lib/planning/plan-generator.ts`
- `tests/lib/planning/` (entire directory — replaced by `tests/planning/`)

### Rewrite
- `lib/pipeline/orchestrator.ts` — 6-stage sequencer with retry
- `lib/planning/types.ts` — new interfaces: ChangeSpec, DetailedPlan, Phase, Task, Substep, ValidationCheck, PlanSeeds, PlannerFailure

### New runtime files
- `lib/planning/plan-validator.ts` — artifact contract enforcement (pure functions)
- `lib/planning/planning-repository.ts` — sole owner of all Supabase reads/writes for planning
- `lib/planning/spec-generator.ts` — generateSpec() + internal helpers
- `lib/planning/detailed-plan-generator.ts` — generateDetailedPlan() + PlanQualityGateError
- `lib/planning/human-task-view.ts` — projectToTasks() (pure, no DB)
- `lib/planning/impact-seeder.ts` — extractPlanSeeds() (pure, no DB)
- `lib/planning/risk-scorer.ts` — scoreFromPlan() (pure, no DB)
- `lib/pipeline/phases/impact-engine.ts` — orchestrator wrapper for impact stage

### New test files
- `tests/planning/plan-validator.test.ts`
- `tests/planning/human-task-view.test.ts`
- `tests/planning/risk-scorer.test.ts`
- `tests/planning/spec-generator.test.ts`
- `tests/pipeline/orchestrator.test.ts`

### Migration
- `supabase/migrations/025_planning_refactor.sql`

---

## Task 1: DB Migration

**Files:**
- Create: `supabase/migrations/025_planning_refactor.sql`

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/025_planning_refactor.sql

-- 1. New table: change_specs (stores the human design contract)
create table change_specs (
  id          uuid primary key default gen_random_uuid(),
  change_id   uuid not null references change_requests(id) on delete cascade,
  version     int not null default 1,
  markdown    text,
  structured  jsonb not null,
  created_at  timestamptz not null default now()
);
create index on change_specs (change_id, version desc);

-- 2. Add new columns to change_plans
alter table change_plans
  add column if not exists plan_json        jsonb,
  add column if not exists version          int not null default 1,
  add column if not exists current_stage    text,
  add column if not exists stage_durations  jsonb,
  add column if not exists failed_stage     text,
  add column if not exists planner_version  int not null default 1,
  add column if not exists started_at       timestamptz,
  add column if not exists ended_at         timestamptz;

-- Remove columns that are now derived or relocated
alter table change_plans
  drop column if exists spec_markdown,
  drop column if exists estimated_files;

-- 3. Add projection metadata to change_plan_tasks
alter table change_plan_tasks
  add column if not exists plan_task_id  text,
  add column if not exists phase_id      text,
  add column if not exists plan_version  int;

-- 4. Add failure tracking to change_requests
alter table change_requests
  add column if not exists retryable              boolean,
  add column if not exists failure_diagnostics    jsonb;

-- Remove draft_plan (replaced by change_specs)
alter table change_requests
  drop column if exists draft_plan;

-- 5. Add drift tracking to change_impacts
alter table change_impacts
  add column if not exists direct_seeds  int,
  add column if not exists drift_ratio   float;
```

- [ ] **Step 2: Apply migration**

```bash
supabase db push
```

Expected: `Applying migration 025_planning_refactor.sql` with no errors. If `change_impacts` doesn't have `direct_seeds`/`drift_ratio`, the `add column if not exists` handles that gracefully.

- [ ] **Step 3: Verify schema**

```bash
supabase db diff
```

Expected: no pending changes (migration fully applied).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/025_planning_refactor.sql
git commit -m "feat: add planning refactor migration (change_specs, plan_json, drift tracking)"
```

---

## Task 2: Core Types

**Files:**
- Rewrite: `lib/planning/types.ts`

- [ ] **Step 1: Rewrite types.ts**

Replace the entire file:

```typescript
// lib/planning/types.ts

// ---- Spec ----

export interface ChangeSpec {
  problem: string
  goals: string[]
  architecture: string
  constraints: string[]
  data_model?: string
  ui_behavior?: string
  policies?: string[]
  out_of_scope: string[]
}

// ---- Plan ----

export type ValidationCheck =
  | { type: 'command'; command: string; success_contains?: string }
  | { type: 'file_exists'; target: string }
  | { type: 'schema'; table: string; expected_columns?: string[] }
  | { type: 'test_pass'; pattern?: string }

export type SubstepAction =
  | 'write_file'
  | 'modify_file'
  | 'run_command'
  | 'verify_schema'
  | 'run_test'
  | 'insert_row'

export interface Substep {
  id: string
  action: SubstepAction
  target?: string    // file path or schema name
  command?: string
  expected?: string[]
}

export type TaskType =
  | 'backend'
  | 'frontend'
  | 'database'
  | 'testing'
  | 'infra'
  | 'api'
  | 'refactor'

export interface Task {
  id: string
  title: string
  description?: string   // optional long-form for UI and human review
  type: TaskType
  files: string[]
  depends_on: string[]   // task ids within the plan
  substeps: Substep[]    // execute in array order; future scheduler may override
  validation: ValidationCheck[]
  expected_result: string
  retryable?: boolean
  parallelizable?: boolean  // task may run alongside others; does NOT affect substep ordering
}

export interface Phase {
  id: string
  title: string
  depends_on: string[]   // phase ids
  tasks: Task[]
}

export interface DetailedPlan {
  schema_version: 1
  planner_version: number
  goal: string
  // branch_name lives as a top-level column on change_plans — not stored here
  phases: Phase[]
}

// ---- Failure ----

export interface PlannerDiagnostics {
  summary: string
  issues: string[]   // first 10 only
  truncated: boolean
}

export type PlannerStage = 'spec' | 'plan' | 'projection' | 'impact' | 'risk' | 'policy'

export interface PlannerFailure {
  stage: PlannerStage
  retryable: boolean
  reason: string
  diagnostics: PlannerDiagnostics
  failed_at: string   // ISO timestamp
}

// ---- Impact seeding ----

export interface PlanSeeds {
  filePaths: string[]
  componentHints: string[]
  hasMigration: boolean
  commands: string[]
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
npx tsc --noEmit
```

Expected: no errors in `lib/planning/types.ts` (other files may still error — that's expected at this stage).

- [ ] **Step 3: Commit**

```bash
git add lib/planning/types.ts
git commit -m "feat: rewrite planning types (ChangeSpec, DetailedPlan, Phase, Task, Substep)"
```

---

## Task 3: Plan Validator

**Files:**
- Create: `lib/planning/plan-validator.ts`
- Create: `tests/planning/plan-validator.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/planning/plan-validator.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { validateSpecInput, validatePlanOutput } from '@/lib/planning/plan-validator'
import type { ChangeSpec, DetailedPlan } from '@/lib/planning/types'

const validSpec: ChangeSpec = {
  problem: 'The planner produces flat tasks',
  goals: ['Replace flat tasks with phases and substeps'],
  architecture: 'New pipeline with 6 stages',
  constraints: ['Must not break existing UI'],
  out_of_scope: ['Execution pipeline changes'],
}

const validPlan: DetailedPlan = {
  schema_version: 1,
  planner_version: 1,
  goal: 'Build new planner',
  phases: [{
    id: 'phase_1',
    title: 'Foundation',
    depends_on: [],
    tasks: [{
      id: 'task_1',
      title: 'Write migration',
      type: 'database',
      files: ['supabase/migrations/025_planning_refactor.sql'],
      depends_on: [],
      substeps: [{ id: 'step_1', action: 'write_file', target: 'supabase/migrations/025_planning_refactor.sql' }],
      validation: [{ type: 'command', command: 'supabase db push' }],
      expected_result: 'Migration applied',
    }],
  }],
}

describe('validateSpecInput', () => {
  it('passes a valid spec', () => {
    const result = validateSpecInput(validSpec)
    expect(result.passed).toBe(true)
    expect(result.diagnostics.issues).toHaveLength(0)
  })

  it('fails when problem is empty', () => {
    const result = validateSpecInput({ ...validSpec, problem: '' })
    expect(result.passed).toBe(false)
    expect(result.diagnostics.issues).toContain('spec.problem is empty')
  })

  it('fails when goals is empty array', () => {
    const result = validateSpecInput({ ...validSpec, goals: [] })
    expect(result.passed).toBe(false)
    expect(result.diagnostics.issues.some(i => i.includes('goals'))).toBe(true)
  })

  it('caps issues at 10 and sets truncated flag', () => {
    // Spec with all fields empty
    const bad: ChangeSpec = { problem: '', goals: [], architecture: '', constraints: [], out_of_scope: null as any }
    const result = validateSpecInput(bad)
    expect(result.diagnostics.issues.length).toBeLessThanOrEqual(10)
    // truncated only applies if > 10 issues; here it's fine either way
  })
})

describe('validatePlanOutput', () => {
  it('passes a valid plan', () => {
    const result = validatePlanOutput(validPlan)
    expect(result.passed).toBe(true)
  })

  it('fails when plan has no phases', () => {
    const result = validatePlanOutput({ ...validPlan, phases: [] })
    expect(result.passed).toBe(false)
    expect(result.diagnostics.issues[0]).toContain('no phases')
  })

  it('fails when a phase has no tasks', () => {
    const plan: DetailedPlan = { ...validPlan, phases: [{ ...validPlan.phases[0], tasks: [] }] }
    const result = validatePlanOutput(plan)
    expect(result.passed).toBe(false)
    expect(result.diagnostics.issues.some(i => i.includes('no tasks'))).toBe(true)
  })

  it('fails when a task has no substeps', () => {
    const task = { ...validPlan.phases[0].tasks[0], substeps: [] }
    const plan: DetailedPlan = { ...validPlan, phases: [{ ...validPlan.phases[0], tasks: [task] }] }
    const result = validatePlanOutput(plan)
    expect(result.passed).toBe(false)
    expect(result.diagnostics.issues.some(i => i.includes('no substeps'))).toBe(true)
  })

  it('fails when a task has neither files nor substep targets', () => {
    const task = { ...validPlan.phases[0].tasks[0], files: [], substeps: [{ id: 's1', action: 'run_test' as const }] }
    const plan: DetailedPlan = { ...validPlan, phases: [{ ...validPlan.phases[0], tasks: [task] }] }
    const result = validatePlanOutput(plan)
    expect(result.passed).toBe(false)
    expect(result.diagnostics.issues.some(i => i.includes('no actionable target'))).toBe(true)
  })

  it('fails when a task has no validation', () => {
    const task = { ...validPlan.phases[0].tasks[0], validation: [] }
    const plan: DetailedPlan = { ...validPlan, phases: [{ ...validPlan.phases[0], tasks: [task] }] }
    const result = validatePlanOutput(plan)
    expect(result.passed).toBe(false)
    expect(result.diagnostics.issues.some(i => i.includes('no validation'))).toBe(true)
  })

  it('fails when a task has no expected_result', () => {
    const task = { ...validPlan.phases[0].tasks[0], expected_result: '' }
    const plan: DetailedPlan = { ...validPlan, phases: [{ ...validPlan.phases[0], tasks: [task] }] }
    const result = validatePlanOutput(plan)
    expect(result.passed).toBe(false)
    expect(result.diagnostics.issues.some(i => i.includes('no expected_result'))).toBe(true)
  })

  it('fails when depends_on references an unknown task id', () => {
    const task = { ...validPlan.phases[0].tasks[0], depends_on: ['task_999'] }
    const plan: DetailedPlan = { ...validPlan, phases: [{ ...validPlan.phases[0], tasks: [task] }] }
    const result = validatePlanOutput(plan)
    expect(result.passed).toBe(false)
    expect(result.diagnostics.issues.some(i => i.includes('task_999'))).toBe(true)
  })

  it('detects circular dependencies', () => {
    const taskA = { ...validPlan.phases[0].tasks[0], id: 'task_a', depends_on: ['task_b'] }
    const taskB: typeof taskA = { ...taskA, id: 'task_b', depends_on: ['task_a'] }
    const plan: DetailedPlan = { ...validPlan, phases: [{ ...validPlan.phases[0], tasks: [taskA, taskB] }] }
    const result = validatePlanOutput(plan)
    expect(result.passed).toBe(false)
    expect(result.diagnostics.issues.some(i => i.includes('circular'))).toBe(true)
  })

  it('accepts a task with no files when a substep has a command', () => {
    const task = {
      ...validPlan.phases[0].tasks[0],
      files: [],
      substeps: [{ id: 's1', action: 'run_command' as const, command: 'npm test' }],
    }
    const plan: DetailedPlan = { ...validPlan, phases: [{ ...validPlan.phases[0], tasks: [task] }] }
    const result = validatePlanOutput(plan)
    expect(result.passed).toBe(true)
  })

  it('caps diagnostics issues at 10', () => {
    // Build a plan with 15 tasks, each missing substeps
    const badTask = (i: number) => ({
      id: `task_${i}`,
      title: `task ${i}`,
      type: 'backend' as const,
      files: [`file_${i}.ts`],
      depends_on: [],
      substeps: [],
      validation: [{ type: 'file_exists' as const, target: `file_${i}.ts` }],
      expected_result: 'done',
    })
    const plan: DetailedPlan = {
      ...validPlan,
      phases: [{ id: 'phase_1', title: 'p', depends_on: [], tasks: Array.from({ length: 15 }, (_, i) => badTask(i)) }],
    }
    const result = validatePlanOutput(plan)
    expect(result.passed).toBe(false)
    expect(result.diagnostics.issues.length).toBeLessThanOrEqual(10)
    expect(result.diagnostics.truncated).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm run test -- tests/planning/plan-validator.test.ts
```

Expected: `FAIL` — `validateSpecInput` and `validatePlanOutput` do not exist yet.

- [ ] **Step 3: Implement plan-validator.ts**

Create `lib/planning/plan-validator.ts`:

```typescript
// lib/planning/plan-validator.ts
import type { ChangeSpec, DetailedPlan, PlannerDiagnostics } from './types'

export interface ValidationResult {
  passed: boolean
  diagnostics: PlannerDiagnostics
}

export function validateSpecInput(spec: ChangeSpec): ValidationResult {
  const issues: string[] = []

  if (!spec.problem?.trim()) issues.push('spec.problem is empty')
  if (!Array.isArray(spec.goals) || spec.goals.length === 0) issues.push('spec.goals is empty')
  if (!spec.architecture?.trim()) issues.push('spec.architecture is empty')
  if (!Array.isArray(spec.out_of_scope)) issues.push('spec.out_of_scope must be an array')

  return buildResult(issues)
}

export function validatePlanOutput(plan: DetailedPlan): ValidationResult {
  const issues: string[] = []

  if (!plan.phases || plan.phases.length === 0) {
    issues.push('plan has no phases')
    return buildResult(issues)
  }

  // Collect all task ids for dependency validation
  const allTaskIds = new Set<string>()
  for (const phase of plan.phases) {
    for (const task of phase.tasks) {
      allTaskIds.add(task.id)
    }
  }

  for (const phase of plan.phases) {
    if (!phase.tasks || phase.tasks.length === 0) {
      issues.push(`phase "${phase.id}" has no tasks`)
      if (issues.length >= 10) return buildResult(issues)
      continue
    }

    for (const task of phase.tasks) {
      // Substeps required
      if (!task.substeps || task.substeps.length === 0) {
        issues.push(`task "${task.id}" has no substeps`)
        if (issues.length >= 10) return buildResult(issues)
      }

      // Actionable target required: files OR substep with command/target
      const hasFiles = task.files?.length > 0
      const hasSubstepTarget = task.substeps?.some(s => s.command || s.target)
      if (!hasFiles && !hasSubstepTarget) {
        issues.push(`task "${task.id}" has no actionable target (no files and no substep command/target)`)
        if (issues.length >= 10) return buildResult(issues)
      }

      // Validation required
      if (!task.validation || task.validation.length === 0) {
        issues.push(`task "${task.id}" has no validation`)
        if (issues.length >= 10) return buildResult(issues)
      }

      // Expected result required
      if (!task.expected_result?.trim()) {
        issues.push(`task "${task.id}" has no expected_result`)
        if (issues.length >= 10) return buildResult(issues)
      }

      // Dependency resolution
      for (const dep of task.depends_on ?? []) {
        if (!allTaskIds.has(dep)) {
          issues.push(`task "${task.id}" depends_on unknown task id "${dep}"`)
          if (issues.length >= 10) return buildResult(issues)
        }
      }
    }
  }

  // Circular dependency check (DFS)
  const depMap = new Map<string, string[]>()
  for (const phase of plan.phases) {
    for (const task of phase.tasks) {
      depMap.set(task.id, task.depends_on ?? [])
    }
  }

  const visited = new Set<string>()
  const stack = new Set<string>()

  function hasCycle(id: string): boolean {
    visited.add(id)
    stack.add(id)
    for (const dep of depMap.get(id) ?? []) {
      if (stack.has(dep)) return true
      if (!visited.has(dep) && hasCycle(dep)) return true
    }
    stack.delete(id)
    return false
  }

  for (const id of allTaskIds) {
    if (!visited.has(id) && hasCycle(id)) {
      issues.push(`circular dependency detected involving task "${id}"`)
      break
    }
  }

  return buildResult(issues)
}

function buildResult(rawIssues: string[]): ValidationResult {
  const capped = rawIssues.slice(0, 10)
  return {
    passed: rawIssues.length === 0,
    diagnostics: {
      summary: rawIssues.length === 0 ? 'all checks passed' : `${rawIssues.length} issue(s) found`,
      issues: capped,
      truncated: rawIssues.length > 10,
    },
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm run test -- tests/planning/plan-validator.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/planning/plan-validator.ts tests/planning/plan-validator.test.ts
git commit -m "feat: add plan-validator with artifact contract enforcement"
```

---

## Task 4: Human Task View

**Files:**
- Create: `lib/planning/human-task-view.ts`
- Create: `tests/planning/human-task-view.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/planning/human-task-view.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { projectToTasks } from '@/lib/planning/human-task-view'
import type { DetailedPlan } from '@/lib/planning/types'

const plan: DetailedPlan = {
  schema_version: 1,
  planner_version: 1,
  goal: 'Test',
  phases: [
    {
      id: 'phase_1',
      title: 'Phase One',
      depends_on: [],
      tasks: [
        {
          id: 'task_1', title: 'First task', description: 'Do the first thing',
          type: 'backend', files: ['lib/foo.ts'], depends_on: [],
          substeps: [{ id: 's1', action: 'write_file', target: 'lib/foo.ts' }],
          validation: [{ type: 'file_exists', target: 'lib/foo.ts' }],
          expected_result: 'File created',
        },
        {
          id: 'task_2', title: 'Second task', description: undefined,
          type: 'testing', files: ['tests/foo.test.ts'], depends_on: ['task_1'],
          substeps: [{ id: 's1', action: 'run_test' }],
          validation: [{ type: 'test_pass' }],
          expected_result: 'Tests pass',
        },
      ],
    },
    {
      id: 'phase_2',
      title: 'Phase Two',
      depends_on: ['phase_1'],
      tasks: [
        {
          id: 'task_3', title: 'Third task', description: 'Phase 2 work',
          type: 'api', files: ['app/api/foo/route.ts'], depends_on: [],
          substeps: [{ id: 's1', action: 'write_file', target: 'app/api/foo/route.ts' }],
          validation: [{ type: 'file_exists', target: 'app/api/foo/route.ts' }],
          expected_result: 'Route exists',
        },
      ],
    },
  ],
}

describe('projectToTasks', () => {
  it('returns one row per task across all phases', () => {
    const tasks = projectToTasks(plan)
    expect(tasks).toHaveLength(3)
  })

  it('assigns monotonically increasing order indices', () => {
    const tasks = projectToTasks(plan)
    expect(tasks[0].orderIndex).toBe(0)
    expect(tasks[1].orderIndex).toBe(1)
    expect(tasks[2].orderIndex).toBe(2)
  })

  it('preserves planTaskId and phaseId', () => {
    const tasks = projectToTasks(plan)
    expect(tasks[0].planTaskId).toBe('task_1')
    expect(tasks[0].phaseId).toBe('phase_1')
    expect(tasks[2].planTaskId).toBe('task_3')
    expect(tasks[2].phaseId).toBe('phase_2')
  })

  it('preserves title and description', () => {
    const tasks = projectToTasks(plan)
    expect(tasks[0].title).toBe('First task')
    expect(tasks[0].description).toBe('Do the first thing')
    expect(tasks[1].description).toBeUndefined()
  })

  it('sets all statuses to pending', () => {
    const tasks = projectToTasks(plan)
    expect(tasks.every(t => t.status === 'pending')).toBe(true)
  })

  it('returns empty array for plan with no tasks', () => {
    const emptyPlan: DetailedPlan = { ...plan, phases: [{ id: 'p1', title: 'P', depends_on: [], tasks: [] }] }
    expect(projectToTasks(emptyPlan)).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm run test -- tests/planning/human-task-view.test.ts
```

Expected: `FAIL` — `projectToTasks` does not exist.

- [ ] **Step 3: Implement human-task-view.ts**

Create `lib/planning/human-task-view.ts`:

```typescript
// lib/planning/human-task-view.ts
import type { DetailedPlan } from './types'

export interface ProjectedTask {
  planTaskId: string
  phaseId: string
  title: string
  description: string | undefined
  orderIndex: number
  status: 'pending'
  files: string[]
}

/**
 * Projects plan_json into a flat list of tasks for change_plan_tasks.
 * Substep ordering within tasks is preserved by definition (array order).
 * Call rebuildTaskProjection in planning-repository to persist — never patch incrementally.
 */
export function projectToTasks(plan: DetailedPlan): ProjectedTask[] {
  const rows: ProjectedTask[] = []
  let orderIndex = 0

  for (const phase of plan.phases) {
    for (const task of phase.tasks) {
      rows.push({
        planTaskId: task.id,
        phaseId: phase.id,
        title: task.title,
        description: task.description,
        orderIndex: orderIndex++,
        status: 'pending',
        files: task.files,
      })
    }
  }

  return rows
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm run test -- tests/planning/human-task-view.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/planning/human-task-view.ts tests/planning/human-task-view.test.ts
git commit -m "feat: add human-task-view projector (plan_json → change_plan_tasks rows)"
```

---

## Task 5: Impact Seeder

**Files:**
- Create: `lib/planning/impact-seeder.ts`

- [ ] **Step 1: Write impact-seeder.ts**

Create `lib/planning/impact-seeder.ts`:

```typescript
// lib/planning/impact-seeder.ts
import type { DetailedPlan, PlanSeeds } from './types'

const MIGRATION_COMMANDS = ['supabase db push', 'supabase migration', 'prisma migrate', 'knex migrate']
const MIGRATION_PATH = /(?:migrations?\/|\.sql$)/i

export function extractPlanSeeds(plan: DetailedPlan): PlanSeeds {
  const filePathSet = new Set<string>()
  const componentHintSet = new Set<string>()
  const commandSet = new Set<string>()
  let hasMigration = false

  for (const phase of plan.phases) {
    for (const task of phase.tasks) {
      // Explicit file paths from task.files
      for (const f of task.files ?? []) {
        filePathSet.add(f)
        if (MIGRATION_PATH.test(f)) hasMigration = true
      }

      // Task type as component hint
      componentHintSet.add(task.type)

      // Substep targets and commands
      for (const step of task.substeps ?? []) {
        if (step.target) {
          filePathSet.add(step.target)
          if (MIGRATION_PATH.test(step.target)) hasMigration = true
        }
        if (step.command) {
          commandSet.add(step.command)
          if (MIGRATION_COMMANDS.some(c => step.command!.startsWith(c))) hasMigration = true
        }
      }

      // Validation commands
      for (const v of task.validation ?? []) {
        if (v.type === 'command') commandSet.add(v.command)
      }
    }
  }

  return {
    filePaths: Array.from(filePathSet),
    componentHints: Array.from(componentHintSet),
    hasMigration,
    commands: Array.from(commandSet),
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | grep impact-seeder
```

Expected: no errors for this file.

- [ ] **Step 3: Commit**

```bash
git add lib/planning/impact-seeder.ts
git commit -m "feat: add impact-seeder to extract plan seeds from plan_json"
```

---

## Task 6: Risk Scorer (planning layer)

**Files:**
- Create: `lib/planning/risk-scorer.ts`
- Create: `tests/planning/risk-scorer.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/planning/risk-scorer.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { scoreFromPlan } from '@/lib/planning/risk-scorer'
import type { DetailedPlan } from '@/lib/planning/types'

function makePlan(overrides: Partial<{
  taskCount: number
  substepsPerTask: number
  taskType: 'backend' | 'database'
  hasMigrationCommand: boolean
}>): DetailedPlan {
  const { taskCount = 3, substepsPerTask = 2, taskType = 'backend', hasMigrationCommand = false } = overrides
  const tasks = Array.from({ length: taskCount }, (_, i) => ({
    id: `task_${i}`,
    title: `Task ${i}`,
    type: taskType,
    files: [`lib/file_${i}.ts`],
    depends_on: [],
    substeps: Array.from({ length: substepsPerTask }, (_, j) => ({
      id: `step_${i}_${j}`,
      action: 'write_file' as const,
      ...(hasMigrationCommand && j === 0 ? { command: 'supabase db push' } : { target: `lib/file_${i}.ts` }),
    })),
    validation: [{ type: 'file_exists' as const, target: `lib/file_${i}.ts` }],
    expected_result: 'done',
  }))
  return {
    schema_version: 1,
    planner_version: 1,
    goal: 'Test',
    phases: [{ id: 'phase_1', title: 'P', depends_on: [], tasks }],
  }
}

describe('scoreFromPlan', () => {
  it('returns low risk for a small, simple plan', () => {
    const result = scoreFromPlan(makePlan({ taskCount: 3, substepsPerTask: 2 }), 0)
    expect(result.riskLevel).toBe('low')
  })

  it('returns higher risk for a large plan', () => {
    const result = scoreFromPlan(makePlan({ taskCount: 15, substepsPerTask: 3 }), 0)
    expect(['medium', 'high']).toContain(result.riskLevel)
  })

  it('boosts risk when plan has migration commands', () => {
    const withMigration = scoreFromPlan(makePlan({ hasMigrationCommand: true }), 0)
    const withoutMigration = scoreFromPlan(makePlan({ hasMigrationCommand: false }), 0)
    expect(withMigration.score).toBeGreaterThan(withoutMigration.score)
  })

  it('boosts risk for database task type', () => {
    const db = scoreFromPlan(makePlan({ taskCount: 3, taskType: 'database' }), 0)
    const be = scoreFromPlan(makePlan({ taskCount: 3, taskType: 'backend' }), 0)
    expect(db.score).toBeGreaterThan(be.score)
  })

  it('boosts risk when drift ratio is high', () => {
    const lowDrift = scoreFromPlan(makePlan({ taskCount: 3 }), 1)
    const highDrift = scoreFromPlan(makePlan({ taskCount: 3 }), 10)
    expect(highDrift.score).toBeGreaterThan(lowDrift.score)
  })

  it('includes plan signals in result', () => {
    const result = scoreFromPlan(makePlan({ taskCount: 4, substepsPerTask: 3 }), 2.5)
    expect(result.signals.taskCount).toBe(4)
    expect(result.signals.substepCount).toBe(12)
    expect(result.signals.driftRatio).toBe(2.5)
  })

  it('identifies the primary risk signal', () => {
    // High drift should dominate
    const result = scoreFromPlan(makePlan({ taskCount: 3 }), 15)
    expect(result.primarySignal).toBe('high_drift')
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm run test -- tests/planning/risk-scorer.test.ts
```

Expected: `FAIL` — `scoreFromPlan` does not exist.

- [ ] **Step 3: Implement risk-scorer.ts**

Create `lib/planning/risk-scorer.ts`:

```typescript
// lib/planning/risk-scorer.ts
import type { DetailedPlan } from './types'

export interface PlanRiskSignals {
  taskCount: number
  substepCount: number
  hasMigration: boolean
  driftRatio: number
  criticalSystemCount: number
  validationDensity: number
}

export interface PlanRiskScore {
  score: number
  riskLevel: 'low' | 'medium' | 'high'
  primarySignal: string
  signals: PlanRiskSignals
}

const CRITICAL_TASK_TYPES = new Set(['database', 'infra'])
const MIGRATION_COMMAND_PREFIXES = ['supabase db push', 'prisma migrate', 'knex migrate']
const MIGRATION_PATH = /(?:migrations?\/|\.sql$)/i

/**
 * Scores plan complexity and drift against the component graph.
 * driftRatio = indirect_impact_count / direct_seed_count from change_impacts.
 */
export function scoreFromPlan(plan: DetailedPlan, driftRatio: number): PlanRiskScore {
  const allTasks = plan.phases.flatMap(p => p.tasks)
  const taskCount = allTasks.length
  const substepCount = allTasks.reduce((sum, t) => sum + (t.substeps?.length ?? 0), 0)
  const validationCount = allTasks.reduce((sum, t) => sum + (t.validation?.length ?? 0), 0)
  const validationDensity = taskCount > 0 ? validationCount / taskCount : 0
  const criticalSystemCount = allTasks.filter(t => CRITICAL_TASK_TYPES.has(t.type)).length

  const hasMigration = allTasks.some(t =>
    t.substeps?.some(s => s.command && MIGRATION_COMMAND_PREFIXES.some(p => s.command!.startsWith(p))) ||
    t.files?.some(f => MIGRATION_PATH.test(f))
  )

  let score = 0
  let primarySignal = 'none'
  let primaryScore = 0

  function addSignal(name: string, points: number) {
    score += points
    if (points > primaryScore) { primaryScore = points; primarySignal = name }
  }

  if (taskCount > 10) addSignal('high_task_count', Math.min((taskCount - 10) * 2, 10))
  if (substepCount > 30) addSignal('high_substep_count', Math.min(substepCount - 30, 8))
  if (hasMigration) addSignal('migration', 6)
  if (criticalSystemCount > 0) addSignal('critical_systems', criticalSystemCount * 3)
  if (driftRatio > 5) addSignal('high_drift', Math.min(Math.floor(driftRatio), 10))
  if (validationDensity < 1) addSignal('weak_validation', 4)

  const riskLevel: 'low' | 'medium' | 'high' = score < 10 ? 'low' : score < 20 ? 'medium' : 'high'

  return {
    score,
    riskLevel,
    primarySignal,
    signals: { taskCount, substepCount, hasMigration, driftRatio, criticalSystemCount, validationDensity },
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm run test -- tests/planning/risk-scorer.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/planning/risk-scorer.ts tests/planning/risk-scorer.test.ts
git commit -m "feat: add plan-layer risk scorer (complexity + drift signals)"
```

---

## Task 7: Planning Repository

**Files:**
- Create: `lib/planning/planning-repository.ts`

No tests for the repository — it is a thin DB adapter. The integration is verified end-to-end in the orchestrator test (Task 11).

- [ ] **Step 1: Implement planning-repository.ts**

Create `lib/planning/planning-repository.ts`:

```typescript
// lib/planning/planning-repository.ts
// Sole owner of all Supabase reads/writes for the planning pipeline.
// Generators and scorers produce plain objects; this module persists them.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChangeSpec, DetailedPlan, PlannerFailure, PlannerStage } from './types'
import type { ProjectedTask } from './human-task-view'

// ---- Spec ----

export async function createSpec(
  db: SupabaseClient,
  changeId: string,
  spec: ChangeSpec,
  markdown: string,
  version: number
): Promise<{ id: string }> {
  const { data, error } = await db
    .from('change_specs')
    .insert({ change_id: changeId, version, structured: spec, markdown })
    .select('id')
    .single()
  if (error || !data) throw new Error(`Failed to create spec: ${error?.message}`)
  return data
}

export async function loadSpecForChange(
  db: SupabaseClient,
  changeId: string
): Promise<{ id: string; structured: ChangeSpec; markdown: string } | null> {
  const { data } = await db
    .from('change_specs')
    .select('id, structured, markdown')
    .eq('change_id', changeId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as any) ?? null
}

// ---- Plan ----

export async function createPlan(
  db: SupabaseClient,
  changeId: string,
  branchName: string,
  planJson: DetailedPlan,
  plannerVersion: number
): Promise<{ id: string }> {
  const { data, error } = await db
    .from('change_plans')
    .insert({
      change_id: changeId,
      status: 'draft',
      branch_name: branchName,
      plan_json: planJson,
      version: 1,
      planner_version: plannerVersion,
      started_at: new Date().toISOString(),
      current_stage: 'plan',
    })
    .select('id')
    .single()
  if (error || !data) throw new Error(`Failed to create plan: ${error?.message}`)
  return data
}

export async function updatePlanStage(
  db: SupabaseClient,
  planId: string,
  stage: PlannerStage,
  stageDurations: Record<string, number>
): Promise<void> {
  await db.from('change_plans').update({
    current_stage: stage,
    stage_durations: stageDurations,
  }).eq('id', planId)
}

export async function finalizePlan(
  db: SupabaseClient,
  planId: string,
  qualityScore: number
): Promise<void> {
  await db.from('change_plans').update({
    current_stage: 'policy',
    plan_quality_score: qualityScore,
    ended_at: new Date().toISOString(),
  }).eq('id', planId)
}

export async function loadPlanForChange(
  db: SupabaseClient,
  changeId: string
): Promise<{
  id: string
  plan_json: DetailedPlan
  branch_name: string
  planner_version: number
  stage_durations: Record<string, number>
} | null> {
  const { data } = await db
    .from('change_plans')
    .select('id, plan_json, branch_name, planner_version, stage_durations')
    .eq('change_id', changeId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return (data as any) ?? null
}

// ---- Task projection ----

/**
 * Delete all task rows for this plan and rebuild from scratch.
 * Never patch incrementally — plan_json is the source of truth.
 */
export async function rebuildTaskProjection(
  db: SupabaseClient,
  planId: string,
  planVersion: number,
  tasks: ProjectedTask[]
): Promise<void> {
  await db.from('change_plan_tasks').delete().eq('plan_id', planId)

  if (tasks.length === 0) return

  const rows = tasks.map(t => ({
    plan_id: planId,
    plan_task_id: t.planTaskId,
    phase_id: t.phaseId,
    description: t.title,
    order_index: t.orderIndex,
    status: t.status,
    plan_version: planVersion,
  }))
  const { error } = await db.from('change_plan_tasks').insert(rows)
  if (error) throw new Error(`Failed to rebuild task projection: ${error.message}`)
}

// ---- Failure ----

export async function recordPlanFailure(
  db: SupabaseClient,
  changeId: string,
  planId: string | null,
  failure: PlannerFailure
): Promise<void> {
  await db.from('change_requests').update({
    pipeline_status: 'failed',
    failed_stage: failure.stage,
    retryable: failure.retryable,
    failure_diagnostics: failure,
  }).eq('id', changeId)
  if (planId) {
    await db.from('change_plans').update({
      failed_stage: failure.stage,
      ended_at: new Date().toISOString(),
    }).eq('id', planId)
  }
}

// ---- Status transitions ----

export async function updatePipelineStatus(
  db: SupabaseClient,
  changeId: string,
  status: string,
  extraFields?: Record<string, unknown>
): Promise<void> {
  await db.from('change_requests').update({
    pipeline_status: status,
    ...extraFields,
  }).eq('id', changeId)
}

export async function guardedStatusTransition(
  db: SupabaseClient,
  changeId: string,
  fromStatus: string,
  toStatus: string
): Promise<boolean> {
  const { data } = await db
    .from('change_requests')
    .update({ pipeline_status: toStatus })
    .eq('id', changeId)
    .eq('pipeline_status', fromStatus)
    .select('id')
  return (data?.length ?? 0) > 0
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
npx tsc --noEmit 2>&1 | grep planning-repository
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/planning/planning-repository.ts
git commit -m "feat: add planning-repository (sole DB layer for planning pipeline)"
```

---

## Task 8: Spec Generator

**Files:**
- Create: `lib/planning/spec-generator.ts`
- Create: `tests/planning/spec-generator.test.ts`

- [ ] **Step 1: Write failing tests for the pure helpers**

Create `tests/planning/spec-generator.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { inferLikelyFilePaths, deriveAssumptions } from '@/lib/planning/spec-generator'

describe('inferLikelyFilePaths', () => {
  it('extracts path-like tokens from intent', () => {
    const paths = inferLikelyFilePaths({
      title: 'Add execution strip',
      intent: 'Create components/app/execution-strip.tsx and update lib/execution/types.ts',
    })
    expect(paths).toContain('components/app/execution-strip.tsx')
    expect(paths).toContain('lib/execution/types.ts')
  })

  it('returns empty array when no paths in intent', () => {
    const paths = inferLikelyFilePaths({ title: 'Refactor auth', intent: 'Improve session handling' })
    expect(paths).toHaveLength(0)
  })

  it('deduplicates paths', () => {
    const paths = inferLikelyFilePaths({
      title: 'Update',
      intent: 'Modify lib/foo.ts and also update lib/foo.ts',
    })
    expect(paths.filter(p => p === 'lib/foo.ts')).toHaveLength(1)
  })
})

describe('deriveAssumptions', () => {
  it('includes additive assumption for feature type', () => {
    const assumptions = deriveAssumptions({ title: 'Add X', intent: 'Add feature', type: 'feature' })
    expect(assumptions.some(a => a.includes('additive'))).toBe(true)
  })

  it('includes migration assumption when intent mentions migrate', () => {
    const assumptions = deriveAssumptions({ title: 'Update schema', intent: 'Need to migrate the DB', type: 'feature' })
    expect(assumptions.some(a => a.toLowerCase().includes('migration'))).toBe(true)
  })

  it('returns empty array for unrecognized signals', () => {
    const assumptions = deriveAssumptions({ title: 'Rename variable', intent: 'Rename foo to bar', type: 'chore' })
    expect(assumptions).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm run test -- tests/planning/spec-generator.test.ts
```

Expected: `FAIL` — exports do not exist.

- [ ] **Step 3: Implement spec-generator.ts**

Create `lib/planning/spec-generator.ts`:

```typescript
// lib/planning/spec-generator.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIProvider } from '@/lib/ai/provider'
import type { ChangeSpec } from './types'

// Exported for testing
export function inferLikelyFilePaths(change: { title: string; intent: string }): string[] {
  const pathPattern = /[\w-]+\/[\w./-]+\.(?:ts|tsx|js|jsx|sql|md)/g
  const hits = change.intent.match(pathPattern) ?? []
  return [...new Set(hits)].slice(0, 10)
}

// Exported for testing
export function deriveAssumptions(change: { title: string; intent: string; type: string }): string[] {
  const assumptions: string[] = []
  const intentLower = change.intent.toLowerCase()
  if (change.type === 'feature') assumptions.push('New functionality will be additive, not breaking')
  if (intentLower.includes('migrat')) assumptions.push('Database migration required')
  if (intentLower.includes('test')) assumptions.push('Test coverage is expected')
  return assumptions
}

async function inferCandidateComponents(
  change: { title: string; intent: string },
  db: SupabaseClient,
  projectId: string
): Promise<string[]> {
  const { data: components } = await db
    .from('system_components')
    .select('name')
    .eq('project_id', projectId)
    .is('deleted_at', null)
  if (!components?.length) return []

  const searchTerms = [
    ...change.title.toLowerCase().split(/\s+/),
    ...change.intent.toLowerCase().split(/\s+/),
  ].filter(t => t.length > 2)

  return components
    .filter(c => {
      const words = c.name.replace(/([A-Z])/g, ' $1').toLowerCase().split(/\s+/)
      return searchTerms.some(term => words.includes(term))
    })
    .map(c => c.name)
    .slice(0, 10)
}

async function loadProjectContext(db: SupabaseClient, projectId: string): Promise<string> {
  const { data: project } = await db
    .from('projects')
    .select('name, description')
    .eq('id', projectId)
    .single()
  return project ? `Project: ${project.name}. ${project.description ?? ''}`.trim() : ''
}

function buildSpecPrompt(
  change: { title: string; intent: string; type: string },
  context: {
    candidateComponents: string[]
    likelyFilePaths: string[]
    assumptions: string[]
    projectContext: string
  }
): string {
  const lines = [
    'You are generating a software specification for a change request.',
    '',
    `Change: ${change.title}`,
    `Type: ${change.type}`,
    `Intent: ${change.intent}`,
  ]

  if (context.projectContext) lines.push(`\nProject context: ${context.projectContext}`)
  if (context.candidateComponents.length > 0) {
    lines.push(`\nLikely affected components:\n${context.candidateComponents.map(c => `- ${c}`).join('\n')}`)
  }
  if (context.likelyFilePaths.length > 0) {
    lines.push(`\nLikely file paths:\n${context.likelyFilePaths.map(f => `- ${f}`).join('\n')}`)
  }
  if (context.assumptions.length > 0) {
    lines.push(`\nInferred assumptions:\n${context.assumptions.map(a => `- ${a}`).join('\n')}`)
  }

  lines.push(`
Produce a specification with these fields:
- problem: what problem this change solves (1-2 sentences)
- goals: 2-5 specific, measurable goals
- architecture: how this will be implemented (2-3 sentences)
- constraints: technical or business constraints (array)
- data_model: (optional) DB schema or data structure changes
- ui_behavior: (optional) UI/UX behavior changes
- policies: (optional) business or technical rules
- out_of_scope: what is explicitly NOT included (array)
- markdown: a human-readable version as a markdown document

Be specific and concrete. Avoid vague language.

Respond with JSON.`)

  return lines.join('\n')
}

export async function generateSpec(
  changeId: string,
  db: SupabaseClient,
  ai: AIProvider
): Promise<{ spec: ChangeSpec; markdown: string }> {
  const { data: change } = await db
    .from('change_requests')
    .select('id, project_id, title, intent, type')
    .eq('id', changeId)
    .single()
  if (!change) throw new Error(`Change not found: ${changeId}`)

  const [candidateComponents, projectContext] = await Promise.all([
    inferCandidateComponents(change, db, change.project_id),
    loadProjectContext(db, change.project_id),
  ])
  const likelyFilePaths = inferLikelyFilePaths(change)
  const assumptions = deriveAssumptions(change)

  const prompt = buildSpecPrompt(change, { candidateComponents, likelyFilePaths, assumptions, projectContext })

  const result = await ai.complete(prompt, {
    responseSchema: {
      type: 'object',
      properties: {
        problem:      { type: 'string' },
        goals:        { type: 'array', items: { type: 'string' } },
        architecture: { type: 'string' },
        constraints:  { type: 'array', items: { type: 'string' } },
        data_model:   { type: 'string' },
        ui_behavior:  { type: 'string' },
        policies:     { type: 'array', items: { type: 'string' } },
        out_of_scope: { type: 'array', items: { type: 'string' } },
        markdown:     { type: 'string' },
      },
      required: ['problem', 'goals', 'architecture', 'constraints', 'out_of_scope', 'markdown'],
    },
    maxTokens: 4096,
  })

  const parsed = JSON.parse(result.content)
  const spec: ChangeSpec = {
    problem:      parsed.problem,
    goals:        parsed.goals,
    architecture: parsed.architecture,
    constraints:  parsed.constraints,
    data_model:   parsed.data_model,
    ui_behavior:  parsed.ui_behavior,
    policies:     parsed.policies,
    out_of_scope: parsed.out_of_scope,
  }
  return { spec, markdown: parsed.markdown }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npm run test -- tests/planning/spec-generator.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/planning/spec-generator.ts tests/planning/spec-generator.test.ts
git commit -m "feat: add spec-generator (Stage 1 of planning pipeline)"
```

---

## Task 9: Detailed Plan Generator

**Files:**
- Create: `lib/planning/detailed-plan-generator.ts`

- [ ] **Step 1: Implement detailed-plan-generator.ts**

Create `lib/planning/detailed-plan-generator.ts`:

```typescript
// lib/planning/detailed-plan-generator.ts
import type { AIProvider } from '@/lib/ai/provider'
import type { ChangeSpec, DetailedPlan } from './types'
import { validatePlanOutput } from './plan-validator'

export class PlanQualityGateError extends Error {
  constructor(public readonly diagnostics: { summary: string; issues: string[]; truncated: boolean }) {
    super(`Plan quality gate failed after retry: ${diagnostics.summary}`)
    this.name = 'PlanQualityGateError'
  }
}

function buildDetailedPlanPrompt(
  change: { title: string; intent: string },
  spec: ChangeSpec,
  plannerVersion: number,
  gateFailures?: string[]
): string {
  const lines = [
    'You are generating a machine-executable implementation plan for a software change.',
    '',
    `Change: ${change.title}`,
    `Intent: ${change.intent}`,
    '',
    'Specification:',
    `Problem: ${spec.problem}`,
    `Goals:\n${spec.goals.map(g => `- ${g}`).join('\n')}`,
    `Architecture: ${spec.architecture}`,
    `Constraints:\n${spec.constraints.map(c => `- ${c}`).join('\n')}`,
  ]

  if (spec.out_of_scope.length > 0) {
    lines.push(`Out of scope:\n${spec.out_of_scope.map(s => `- ${s}`).join('\n')}`)
  }

  if (gateFailures?.length) {
    lines.push('', 'The previous attempt failed these quality gates — fix ALL of them:')
    lines.push(...gateFailures.map(f => `- ${f}`))
  }

  lines.push(`
Rules — every task MUST have:
1. At least one substep
2. At least one file in files[] OR a substep with command or target
3. At least one validation check
4. A non-empty expected_result
5. depends_on references that exist within this plan

Task types: backend, frontend, database, testing, infra, api, refactor
Substep actions: write_file, modify_file, run_command, verify_schema, run_test, insert_row
Validation types:
  { "type": "command", "command": "npm test", "success_contains": "passed" }
  { "type": "file_exists", "target": "lib/foo.ts" }
  { "type": "schema", "table": "foo", "expected_columns": ["id", "name"] }
  { "type": "test_pass", "pattern": "foo.test" }

Respond with JSON:
{
  "schema_version": 1,
  "planner_version": ${plannerVersion},
  "goal": "...",
  "phases": [
    {
      "id": "phase_1",
      "title": "...",
      "depends_on": [],
      "tasks": [
        {
          "id": "task_1",
          "title": "...",
          "description": "...",
          "type": "database",
          "files": ["supabase/migrations/025_foo.sql"],
          "depends_on": [],
          "substeps": [
            { "id": "step_1", "action": "write_file", "target": "supabase/migrations/025_foo.sql" },
            { "id": "step_2", "action": "run_command", "command": "supabase db push", "expected": ["Done"] }
          ],
          "validation": [{ "type": "command", "command": "supabase db push", "success_contains": "Done" }],
          "expected_result": "Migration applied successfully"
        }
      ]
    }
  ]
}`)

  return lines.join('\n')
}

export async function generateDetailedPlan(
  change: { title: string; intent: string },
  spec: ChangeSpec,
  plannerVersion: number,
  ai: AIProvider
): Promise<DetailedPlan> {
  // First attempt
  const prompt = buildDetailedPlanPrompt(change, spec, plannerVersion)
  const result = await ai.complete(prompt, { maxTokens: 8192 })
  const plan: DetailedPlan = JSON.parse(result.content)

  const validation = validatePlanOutput(plan)
  if (validation.passed) return plan

  // One retry with gate failures included
  const retryPrompt = buildDetailedPlanPrompt(change, spec, plannerVersion, validation.diagnostics.issues)
  const retryResult = await ai.complete(retryPrompt, { maxTokens: 8192 })
  const retryPlan: DetailedPlan = JSON.parse(retryResult.content)

  const retryValidation = validatePlanOutput(retryPlan)
  if (!retryValidation.passed) {
    throw new PlanQualityGateError(retryValidation.diagnostics)
  }

  return retryPlan
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
npx tsc --noEmit 2>&1 | grep detailed-plan-generator
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/planning/detailed-plan-generator.ts
git commit -m "feat: add detailed-plan-generator with quality gate and retry"
```

---

## Task 10: Impact Engine Phase

**Files:**
- Create: `lib/pipeline/phases/impact-engine.ts`

This phase replaces `impact-analysis.ts`. It loads seeds from `plan_json` instead of from `draft_plan`.

- [ ] **Step 1: Implement impact-engine.ts**

Create `lib/pipeline/phases/impact-engine.ts`:

```typescript
// lib/pipeline/phases/impact-engine.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIProvider } from '@/lib/ai/provider'
import { runImpactAnalysis } from '@/lib/impact/impact-analyzer'
import { extractPlanSeeds } from '@/lib/planning/impact-seeder'
import type { DetailedPlan } from '@/lib/planning/types'

export async function runImpactEnginePhase(
  changeId: string,
  db: SupabaseClient,
  ai: AIProvider
): Promise<void> {
  const startedAt = new Date().toISOString()

  const { data: change, error } = await db
    .from('change_requests')
    .select('id, pipeline_status, phase_timings')
    .eq('id', changeId)
    .single()
  if (error || !change) throw new Error(`Change not found: ${changeId}`)

  if (change.pipeline_status !== 'plan_generated') {
    throw new Error(
      `Cannot start impact analysis: expected pipeline_status 'plan_generated', got '${change.pipeline_status}'`
    )
  }

  // Load plan_json to extract seeds
  const { data: planRow } = await db
    .from('change_plans')
    .select('plan_json')
    .eq('change_id', changeId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const planJson = planRow?.plan_json as DetailedPlan | null
  const seeds = planJson
    ? extractPlanSeeds(planJson)
    : { filePaths: [], componentHints: [], hasMigration: false, commands: [] }

  // Guarded status transition
  const { data: transitioned } = await db
    .from('change_requests')
    .update({ pipeline_status: 'impact_analyzing' })
    .eq('id', changeId)
    .eq('pipeline_status', 'plan_generated')
    .select('id')
  if (!transitioned?.length) {
    throw new Error('Impact analysis transition failed: concurrent execution detected')
  }

  try {
    await runImpactAnalysis(changeId, db, ai, {
      new_file_paths: seeds.filePaths,
      component_names: seeds.componentHints,
      assumptions: [],
    })

    const completedAt = new Date().toISOString()
    const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime()

    await db.from('change_requests').update({
      pipeline_status: 'impact_analyzed',
      phase_timings: {
        ...(change.phase_timings as Record<string, unknown> ?? {}),
        impact_analysis: { started_at: startedAt, completed_at: completedAt, duration_ms: durationMs },
      },
    }).eq('id', changeId)

  } catch (err) {
    await db.from('change_requests').update({
      pipeline_status: 'failed',
      failed_stage: 'impact',
    }).eq('id', changeId)
    throw err
  }
}
```

- [ ] **Step 2: Verify TypeScript**

```bash
npx tsc --noEmit 2>&1 | grep impact-engine
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/pipeline/phases/impact-engine.ts
git commit -m "feat: add impact-engine phase (plan-seeded impact analysis)"
```

---

## Task 11: Orchestrator Rewrite + Orchestrator Test

**Files:**
- Rewrite: `lib/pipeline/orchestrator.ts`
- Create: `tests/pipeline/orchestrator.test.ts`

- [ ] **Step 1: Write the failing orchestrator test**

Create `tests/pipeline/orchestrator.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { runPipeline } from '@/lib/pipeline/orchestrator'

// Minimal DB that returns null for every query (simulates change not found)
const nullDb = {
  from: () => ({
    select: () => ({
      eq: () => ({
        single: async () => ({ data: null, error: null }),
        order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null }) }) }),
        maybeSingle: async () => ({ data: null }),
        eq: () => ({
          select: () => ({ data: [] }),
          single: async () => ({ data: null, error: null }),
        }),
      }),
    }),
    update: () => ({ eq: () => ({ eq: () => ({ select: () => ({ data: [] }) }), select: () => ({ data: [] }) }) }),
    insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { message: 'mock' } }) }) }),
    delete: () => ({ eq: () => ({}) }),
  }),
} as any

describe('runPipeline', () => {
  it('throws when change is not found', async () => {
    await expect(runPipeline('nonexistent-id', nullDb, {} as any))
      .rejects.toThrow('Change not found')
  })
})
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
npm run test -- tests/pipeline/orchestrator.test.ts
```

Expected: `FAIL` — imports from the new orchestrator will fail since old code is still in place.

- [ ] **Step 3: Rewrite orchestrator.ts**

Replace the entire file at `lib/pipeline/orchestrator.ts`:

```typescript
// lib/pipeline/orchestrator.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIProvider } from '@/lib/ai/provider'
import { generateSpec } from '@/lib/planning/spec-generator'
import { generateDetailedPlan, PlanQualityGateError } from '@/lib/planning/detailed-plan-generator'
import { validateSpecInput } from '@/lib/planning/plan-validator'
import { projectToTasks } from '@/lib/planning/human-task-view'
import { scoreFromPlan } from '@/lib/planning/risk-scorer'
import {
  createSpec,
  createPlan,
  updatePlanStage,
  finalizePlan,
  recordPlanFailure,
  rebuildTaskProjection,
  loadSpecForChange,
  loadPlanForChange,
  updatePipelineStatus,
  guardedStatusTransition,
} from '@/lib/planning/planning-repository'
import { runImpactEnginePhase } from './phases/impact-engine'
import type { PlannerFailure, PlannerStage } from '@/lib/planning/types'

const STAGE_ORDER: PlannerStage[] = ['spec', 'plan', 'projection', 'impact', 'risk', 'policy']

function shouldRunStage(startStage: PlannerStage, thisStage: PlannerStage): boolean {
  return STAGE_ORDER.indexOf(thisStage) >= STAGE_ORDER.indexOf(startStage)
}

function deriveBranchName(goal: string, changeId: string): string {
  const slug = goal.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/-$/, '')
  return `sf/${changeId.slice(0, 8)}-${slug}`
}

export async function runPipeline(
  changeId: string,
  db: SupabaseClient,
  ai: AIProvider,
  opts: { forceReset?: boolean } = {}
): Promise<void> {
  const { data: change } = await db
    .from('change_requests')
    .select('id, pipeline_status, failed_stage, title, intent, type')
    .eq('id', changeId)
    .single()
  if (!change) throw new Error(`Change not found: ${changeId}`)

  const isRetry =
    change.pipeline_status === 'failed' &&
    change.failed_stage &&
    !opts.forceReset

  const startStage: PlannerStage = isRetry
    ? ((change.failed_stage as PlannerStage) ?? 'spec')
    : 'spec'

  if (!isRetry) {
    const ok = await guardedStatusTransition(db, changeId, 'validated', 'planning')
    if (!ok) throw new Error(`Cannot start planning: change must be in 'validated' status`)
  } else {
    await updatePipelineStatus(db, changeId, 'planning', {
      failed_stage: null,
      retryable: null,
      failure_diagnostics: null,
    })
  }

  let planRow = await loadPlanForChange(db, changeId)
  let planId: string | null = planRow?.id ?? null
  const stageDurations: Record<string, number> = { ...(planRow?.stage_durations ?? {}) }
  const plannerVersion = isRetry ? ((planRow?.planner_version ?? 1) + 1) : 1

  try {
    // Stage 1: Generate Spec
    if (shouldRunStage(startStage, 'spec')) {
      const t = Date.now()
      await updatePipelineStatus(db, changeId, 'spec_generating')
      const { spec, markdown } = await generateSpec(changeId, db, ai)
      const specCheck = validateSpecInput(spec)
      if (!specCheck.passed) {
        throw Object.assign(new Error(`Spec validation failed: ${specCheck.diagnostics.summary}`), {
          _stage: 'spec' as PlannerStage,
          _diagnostics: specCheck.diagnostics,
        })
      }
      await createSpec(db, changeId, spec, markdown, plannerVersion)
      stageDurations['spec'] = Date.now() - t
      await updatePipelineStatus(db, changeId, 'spec_generated')
    }

    // Stage 2: Generate Detailed Plan
    if (shouldRunStage(startStage, 'plan')) {
      const t = Date.now()
      await updatePipelineStatus(db, changeId, 'plan_generating')
      const specRow = await loadSpecForChange(db, changeId)
      if (!specRow) {
        throw Object.assign(new Error('No spec found — cannot generate plan'), { _stage: 'plan' as PlannerStage })
      }
      const plan = await generateDetailedPlan(change, specRow.structured, plannerVersion, ai)
      const branchName = deriveBranchName(plan.goal, changeId)
      const { id } = await createPlan(db, changeId, branchName, plan, plannerVersion)
      planId = id
      stageDurations['plan'] = Date.now() - t
      await updatePipelineStatus(db, changeId, 'plan_generated')
    }

    // Ensure planId is resolved for remaining stages
    if (!planId) {
      planRow = await loadPlanForChange(db, changeId)
      planId = planRow?.id ?? null
    }
    if (!planId) throw new Error('No plan row found — cannot continue')

    // Stage 3: Project Human Task View
    if (shouldRunStage(startStage, 'projection')) {
      const t = Date.now()
      const currentPlan = await loadPlanForChange(db, changeId)
      if (currentPlan) {
        const tasks = projectToTasks(currentPlan.plan_json)
        await rebuildTaskProjection(db, planId, currentPlan.planner_version, tasks)
      }
      stageDurations['projection'] = Date.now() - t
      await updatePlanStage(db, planId, 'projection', stageDurations)
    }

    // Stage 4: Impact Analysis
    if (shouldRunStage(startStage, 'impact')) {
      const t = Date.now()
      await runImpactEnginePhase(changeId, db, ai)
      stageDurations['impact'] = Date.now() - t
      await updatePlanStage(db, planId, 'impact', stageDurations)
    }

    // Stage 5: Score Risk
    if (shouldRunStage(startStage, 'risk')) {
      const t = Date.now()
      await updatePipelineStatus(db, changeId, 'scoring')
      const currentPlan = await loadPlanForChange(db, changeId)
      if (currentPlan) {
        const { data: impactRow } = await db
          .from('change_impacts')
          .select('drift_ratio, direct_seeds')
          .eq('change_id', changeId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        const driftRatio = (impactRow as any)?.drift_ratio ?? 0
        const riskScore = scoreFromPlan(currentPlan.plan_json, driftRatio)
        await db.from('change_requests').update({
          risk_level: riskScore.riskLevel,
          pipeline_status: 'scored',
        }).eq('id', changeId)
      }
      stageDurations['risk'] = Date.now() - t
      await updatePlanStage(db, planId, 'risk', stageDurations)
    }

    // Stage 6: Apply Execution Policy
    const { data: planMeta } = await db
      .from('change_plans')
      .select('plan_quality_score')
      .eq('id', planId)
      .single()
    const qualityScore = (planMeta as any)?.plan_quality_score ?? 1.0
    await finalizePlan(db, planId, qualityScore)
    await applyExecutionPolicy(changeId, planId, qualityScore, db, ai)

  } catch (err) {
    const failure = buildFailure(err)
    await recordPlanFailure(db, changeId, planId, failure)
    throw err
  }
}

async function applyExecutionPolicy(
  changeId: string,
  planId: string,
  qualityScore: number,
  db: SupabaseClient,
  ai: AIProvider
): Promise<void> {
  const { data: change } = await db
    .from('change_requests')
    .select('project_id, risk_level')
    .eq('id', changeId)
    .single()
  if (!change) return

  const { data: projectRow } = await db
    .from('projects')
    .select('project_settings')
    .eq('id', (change as any).project_id)
    .single()

  const riskPolicy = (projectRow?.project_settings as any)?.riskPolicy ?? {
    low: 'auto', medium: 'approval', high: 'manual',
  }
  const riskLevel: string = (change as any).risk_level ?? 'low'

  // Explicit precedence — no hidden branching
  let policy: 'auto' | 'approval' | 'manual' = riskPolicy[riskLevel] ?? 'manual'
  if (policy === 'auto' && qualityScore < 0.5) policy = 'approval'

  if (policy === 'auto') {
    await db.from('change_plans')
      .update({ status: 'approved', approved_at: new Date().toISOString() })
      .eq('id', planId)
    // Lazy import avoids pulling Docker deps at module load time
    const { DockerExecutor } = await import('@/lib/execution/executors/docker-executor')
    const { runExecution } = await import('@/lib/execution/execution-orchestrator')
    runExecution(changeId, db, ai, new DockerExecutor()).catch(err =>
      console.error(`[orchestrator] auto-execution failed for change ${changeId}:`, err)
    )
  } else if (policy === 'approval') {
    await db.from('change_requests')
      .update({ status: 'awaiting_approval', pipeline_status: 'awaiting_approval' })
      .eq('id', changeId)
  }
  // manual → stays at 'scored', user navigates to detail page
}

function buildFailure(err: unknown): PlannerFailure {
  const e = err as any
  const stage: PlannerStage = e?._stage ?? guessStageFromMessage(e?.message)
  const isQualityGate = err instanceof PlanQualityGateError
  const rawMessage: string = e?.message ?? String(err)
  const rawIssues: string[] = isQualityGate ? e.diagnostics.issues : [rawMessage]
  const truncated = rawIssues.length > 10

  return {
    stage,
    retryable: !isQualityGate,
    reason: isQualityGate ? 'quality_gate' : rawMessage.slice(0, 200),
    diagnostics: {
      summary: isQualityGate ? e.diagnostics.summary : rawMessage.slice(0, 200),
      issues: rawIssues.slice(0, 10),
      truncated,
    },
    failed_at: new Date().toISOString(),
  }
}

function guessStageFromMessage(msg: unknown): PlannerStage {
  const m = String(msg ?? '').toLowerCase()
  if (m.includes('spec')) return 'spec'
  if (m.includes('plan')) return 'plan'
  if (m.includes('projection')) return 'projection'
  if (m.includes('impact')) return 'impact'
  if (m.includes('risk')) return 'risk'
  return 'policy'
}
```

- [ ] **Step 4: Run orchestrator test**

```bash
npm run test -- tests/pipeline/orchestrator.test.ts
```

Expected: the status-guard test passes.

- [ ] **Step 5: Run full test suite**

```bash
npm run test
```

Expected: new tests pass. Some tests in `tests/lib/planning/` may fail — they will be deleted in Task 12.

- [ ] **Step 6: Commit**

```bash
git add lib/pipeline/orchestrator.ts tests/pipeline/orchestrator.test.ts
git commit -m "feat: rewrite orchestrator as 6-stage planning pipeline with retry semantics"
```

---

## Task 12: Delete Old Files

**Files:**
- Delete: everything listed in the "Delete" section of the File Map above

- [ ] **Step 1: Delete old planning library files**

```bash
rm lib/pipeline/phases/draft-plan.ts
rm lib/pipeline/phases/impact-analysis.ts
rm lib/pipeline/phases/plan-generation.ts
rm lib/planning/draft-planner.ts
rm lib/planning/phases.ts
rm lib/planning/prompt-builders.ts
rm lib/planning/task-validator.ts
rm lib/planning/add-task.ts
rm lib/planning/plan-generator.ts
```

- [ ] **Step 2: Delete old planning tests**

```bash
rm -r tests/lib/planning/
```

- [ ] **Step 3: Run TypeScript to find broken imports**

```bash
npx tsc --noEmit
```

Expected: errors only for files that imported the deleted modules. Fix any broken imports in API routes or other callers.

- [ ] **Step 4: Check for remaining imports of deleted files**

```bash
grep -r "draft-planner\|draft-plan\|plan-generator\|prompt-builders\|task-validator\|impact-analysis\|add-task\|runDraftPlan\|runDraftPlanPhase\|runPlanGenerationPhase" --include="*.ts" --include="*.tsx" lib/ app/ tests/ 2>/dev/null
```

Expected: no matches. If any appear, update those files to remove or replace the import.

- [ ] **Step 5: Run full test suite**

```bash
npm run test
```

Expected: all remaining tests pass. Old planning tests are gone; new ones in `tests/planning/` pass.

- [ ] **Step 6: Run lint**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: delete old planning phases and tests (replaced by new 6-stage pipeline)"
```

---

## Task 13: End-to-End Smoke Verification

- [ ] **Step 1: Start the dev server**

```bash
npm run dev
```

Expected: server starts on port 3000 with no module-not-found errors.

- [ ] **Step 2: Trigger pipeline via API (replace IDs with real values)**

```bash
curl -X POST http://localhost:3000/api/change-requests/<change-id>/pipeline \
  -H "Content-Type: application/json" \
  -d '{}'
```

Expected: returns 200 or 202. Check Supabase `change_requests.pipeline_status` transitions through `planning → spec_generating → spec_generated → plan_generating → plan_generated → impact_analyzing → impact_analyzed → scoring → scored`.

- [ ] **Step 3: Verify artifacts in Supabase**

Check:
- `change_specs`: one row with `structured` JSON containing `problem`, `goals`, `architecture`
- `change_plans`: one row with `plan_json` containing `phases[].tasks[].substeps[]`
- `change_plan_tasks`: rows with `plan_task_id` and `phase_id` populated

- [ ] **Step 4: Final test + lint run**

```bash
npm run test && npm run lint
```

Expected: both pass with no errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: planning refactor complete — 6-stage pipeline with structured plan_json"
```
