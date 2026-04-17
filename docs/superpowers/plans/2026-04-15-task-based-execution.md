# Task-Based Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the iteration-based execution loop with a task-by-task loop: implement one plan task, validate immediately, repair if needed, mark done/failed, continue — with graph-based retrigger of failed tasks.

**Architecture:** Six new focused modules (`task-locker`, `task-retrigger`, `task-validator`, `task-recovery`, `task-runner`, `execution-summary`) replace the monolithic iteration loop in `execution-orchestrator.ts`. The orchestrator becomes a thin coordinator. The Docker executor, inline-repair, repair-phase, and stuck-detector are reused unchanged.

**Tech Stack:** TypeScript, Supabase (PostgreSQL), Next.js API routes, Vitest

---

## File Map

**New files:**
- `supabase/migrations/029_task_based_execution.sql`
- `lib/execution/task-locker.ts`
- `lib/execution/task-retrigger.ts`
- `lib/execution/execution-summary.ts`
- `lib/execution/task-validator.ts`
- `lib/execution/task-recovery.ts`
- `lib/execution/task-runner.ts`
- `tests/lib/execution/task-locker.test.ts`
- `tests/lib/execution/task-retrigger.test.ts`
- `tests/lib/execution/execution-summary.test.ts`

**Modified files:**
- `lib/execution/execution-types-v2.ts` — add `TaskRunSummary`, new event types
- `lib/execution/execution-orchestrator.ts` — replace iteration loop with task loop
- `app/api/change-requests/[id]/execute/route.ts` — add `fromTaskId` retrigger support
- `app/api/change-requests/[id]/execute/events/route.ts` — include task statuses in response
- `app/projects/[id]/changes/[changeId]/execution/execution-view.tsx` — task cards replacing iteration cards

---

### Task 1: Database migration

**Files:**
- Create: `supabase/migrations/029_task_based_execution.sql`

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/029_task_based_execution.sql

-- Task dependencies: task IDs that must be 'done' before this task can start
ALTER TABLE change_plan_tasks
  ADD COLUMN IF NOT EXISTS dependencies uuid[] NOT NULL DEFAULT '{}';

-- Lock timing: used for crash recovery (zombie task cleanup)
ALTER TABLE change_plan_tasks
  ADD COLUMN IF NOT EXISTS locked_at timestamptz;

-- Outcome timestamps / diagnostics
ALTER TABLE change_plan_tasks
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

ALTER TABLE change_plan_tasks
  ADD COLUMN IF NOT EXISTS failure_reason text;

-- Which dependency caused this task to be blocked
ALTER TABLE change_plan_tasks
  ADD COLUMN IF NOT EXISTS blocked_by_task_id uuid REFERENCES change_plan_tasks(id);

-- Index: retrigger graph traversal (find all tasks blocked by a given task)
CREATE INDEX IF NOT EXISTS change_plan_tasks_blocked_by_idx
  ON change_plan_tasks (blocked_by_task_id)
  WHERE blocked_by_task_id IS NOT NULL;

-- Index: crash recovery query (find stuck in_progress tasks by lock time)
CREATE INDEX IF NOT EXISTS change_plan_tasks_locked_at_idx
  ON change_plan_tasks (locked_at)
  WHERE status = 'in_progress';
```

- [ ] **Step 2: Apply migration**

```bash
supabase db push
```

Expected: migration applied with no errors.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/029_task_based_execution.sql
git commit -m "feat: add task dependency + lock timing columns to change_plan_tasks"
```

---

### Task 2: New types in `execution-types-v2.ts`

**Files:**
- Modify: `lib/execution/execution-types-v2.ts`

- [ ] **Step 1: Add `TaskRunSummary` type and new event types**

In `lib/execution/execution-types-v2.ts`, add after the `ExecutionSummary` interface:

```typescript
// ── Task-based execution summary ───────────────────────────────────────────────

export interface TaskRunSummary {
  completedTasks: string[]   // task IDs
  failedTasks: string[]
  blockedTasks: string[]
  skippedTasks: string[]
  totalTasks: number
  durationMs: number
  finalStatus: 'success' | 'partial' | 'failed'
}

export interface TaskBudget {
  maxInlineRepairs: number
  maxRepairPhaseAttempts: number
}

export const DEFAULT_TASK_BUDGET: TaskBudget = {
  maxInlineRepairs: 3,
  maxRepairPhaseAttempts: 2,
}
```

And add the new event types to the `EVENT_TYPES` array:

```typescript
// Add these entries to the EVENT_TYPES array:
'task.started',
'task.validation_started',
'task.validation_passed',
'task.validation_failed',
'task.repair_started',
'task.repair_completed',
'task.completed',
'task.failed',
'task.blocked',
```

- [ ] **Step 2: Verify types compile**

```bash
npx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add lib/execution/execution-types-v2.ts
git commit -m "feat: add TaskRunSummary, TaskBudget, task event types"
```

---

### Task 3: `task-locker.ts`

**Files:**
- Create: `lib/execution/task-locker.ts`
- Create: `tests/lib/execution/task-locker.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/lib/execution/task-locker.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { acquireTaskLock, releaseTaskDone, releaseTaskFailed, crashRecoveryCleanup } from '@/lib/execution/task-locker'

function makeDb(updateResult: { count: number }) {
  const eq = vi.fn().mockReturnThis()
  const update = vi.fn().mockReturnValue({ eq, select: vi.fn().mockReturnValue({ eq, data: Array(updateResult.count).fill({}) }) })
  const from = vi.fn().mockReturnValue({ update })
  return { from, _update: update, _eq: eq } as unknown as import('@supabase/supabase-js').SupabaseClient
}

describe('acquireTaskLock', () => {
  it('returns true when exactly one row is updated (lock acquired)', async () => {
    const db = {
      from: () => ({
        update: () => ({
          eq: () => ({
            eq: () => ({
              select: () => ({ data: [{ id: 'task-1' }], error: null }),
            }),
          }),
        }),
      }),
    } as unknown as import('@supabase/supabase-js').SupabaseClient
    expect(await acquireTaskLock(db, 'task-1', 'run-1')).toBe(true)
  })

  it('returns false when no rows updated (already locked by other run)', async () => {
    const db = {
      from: () => ({
        update: () => ({
          eq: () => ({
            eq: () => ({
              select: () => ({ data: [], error: null }),
            }),
          }),
        }),
      }),
    } as unknown as import('@supabase/supabase-js').SupabaseClient
    expect(await acquireTaskLock(db, 'task-1', 'run-2')).toBe(false)
  })
})

describe('crashRecoveryCleanup', () => {
  it('does not throw when no zombie tasks exist', async () => {
    const db = {
      from: () => ({
        update: () => ({
          eq: () => ({
            lt: () => ({ error: null }),
          }),
        }),
      }),
    } as unknown as import('@supabase/supabase-js').SupabaseClient
    await expect(crashRecoveryCleanup(db)).resolves.not.toThrow()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm run test -- tests/lib/execution/task-locker.test.ts
```

Expected: FAIL with "Cannot find module '@/lib/execution/task-locker'"

- [ ] **Step 3: Implement `task-locker.ts`**

```typescript
// lib/execution/task-locker.ts
import type { SupabaseClient } from '@supabase/supabase-js'

/** Crash recovery timeout: tasks locked longer than this are considered zombies */
const LOCK_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes

/**
 * Atomically acquire a task lock.
 * Uses a conditional UPDATE (WHERE status = 'pending') to prevent double-execution.
 * Returns true if the lock was acquired, false if another run holds it.
 */
export async function acquireTaskLock(
  db: SupabaseClient,
  taskId: string,
  runId: string,
): Promise<boolean> {
  const { data } = await db
    .from('change_plan_tasks')
    .update({
      status: 'in_progress',
      locked_by_run_id: runId,
      locked_at: new Date().toISOString(),
    })
    .eq('id', taskId)
    .eq('status', 'pending')
    .select('id')
  return (data?.length ?? 0) > 0
}

/** Mark a task as successfully completed. */
export async function releaseTaskDone(
  db: SupabaseClient,
  taskId: string,
): Promise<void> {
  await db.from('change_plan_tasks').update({
    status: 'done',
    completed_at: new Date().toISOString(),
    locked_by_run_id: null,
    locked_at: null,
  }).eq('id', taskId)
}

/** Mark a task as failed with a reason. */
export async function releaseTaskFailed(
  db: SupabaseClient,
  taskId: string,
  reason: string,
): Promise<void> {
  await db.from('change_plan_tasks').update({
    status: 'failed',
    failure_reason: reason.slice(0, 500),
    locked_by_run_id: null,
    locked_at: null,
  }).eq('id', taskId)
}

/** Mark a task as blocked by a dependency. */
export async function markTaskBlocked(
  db: SupabaseClient,
  taskId: string,
  blockedByTaskId: string,
): Promise<void> {
  await db.from('change_plan_tasks').update({
    status: 'blocked',
    blocked_by_task_id: blockedByTaskId,
  }).eq('id', taskId)
}

/**
 * Release tasks that were locked by a dead process.
 * Called at execution startup to clear zombie in_progress tasks.
 */
export async function crashRecoveryCleanup(db: SupabaseClient): Promise<void> {
  const cutoff = new Date(Date.now() - LOCK_TIMEOUT_MS).toISOString()
  await db.from('change_plan_tasks')
    .update({ status: 'pending', locked_by_run_id: null, locked_at: null })
    .eq('status', 'in_progress')
    .lt('locked_at', cutoff)
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm run test -- tests/lib/execution/task-locker.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/execution/task-locker.ts tests/lib/execution/task-locker.test.ts
git commit -m "feat: task-locker — conditional DB lock acquire/release + crash recovery"
```

---

### Task 4: `task-retrigger.ts`

**Files:**
- Create: `lib/execution/task-retrigger.ts`
- Create: `tests/lib/execution/task-retrigger.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/lib/execution/task-retrigger.test.ts
import { describe, it, expect } from 'vitest'
import { collectDownstreamIds } from '@/lib/execution/task-retrigger'

interface T { id: string; dependencies: string[] }

describe('collectDownstreamIds', () => {
  it('returns only the target when it has no dependents', () => {
    const tasks: T[] = [
      { id: 'A', dependencies: [] },
      { id: 'B', dependencies: [] },
    ]
    expect(collectDownstreamIds('A', tasks)).toEqual(new Set(['A']))
  })

  it('includes direct dependent', () => {
    const tasks: T[] = [
      { id: 'A', dependencies: [] },
      { id: 'B', dependencies: ['A'] },
    ]
    expect(collectDownstreamIds('A', tasks)).toEqual(new Set(['A', 'B']))
  })

  it('includes transitive dependents recursively', () => {
    const tasks: T[] = [
      { id: 'A', dependencies: [] },
      { id: 'B', dependencies: ['A'] },
      { id: 'C', dependencies: ['B'] },
      { id: 'D', dependencies: ['C'] },
    ]
    expect(collectDownstreamIds('A', tasks)).toEqual(new Set(['A', 'B', 'C', 'D']))
  })

  it('does not include tasks in a parallel branch', () => {
    const tasks: T[] = [
      { id: 'A', dependencies: [] },
      { id: 'B', dependencies: ['A'] },
      { id: 'X', dependencies: [] },  // independent
      { id: 'Y', dependencies: ['X'] },
    ]
    const result = collectDownstreamIds('A', tasks)
    expect(result.has('X')).toBe(false)
    expect(result.has('Y')).toBe(false)
    expect(result).toEqual(new Set(['A', 'B']))
  })

  it('handles diamond dependency without duplicates', () => {
    // A -> B -> D
    // A -> C -> D
    const tasks: T[] = [
      { id: 'A', dependencies: [] },
      { id: 'B', dependencies: ['A'] },
      { id: 'C', dependencies: ['A'] },
      { id: 'D', dependencies: ['B', 'C'] },
    ]
    expect(collectDownstreamIds('A', tasks)).toEqual(new Set(['A', 'B', 'C', 'D']))
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm run test -- tests/lib/execution/task-retrigger.test.ts
```

Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement `task-retrigger.ts`**

```typescript
// lib/execution/task-retrigger.ts
import type { SupabaseClient } from '@supabase/supabase-js'

interface TaskDep {
  id: string
  dependencies: string[]
}

/**
 * Collect the target task and all transitive dependents (tasks that depend on it,
 * directly or indirectly). Returns a Set of task IDs to reset.
 */
export function collectDownstreamIds(
  fromTaskId: string,
  tasks: TaskDep[],
): Set<string> {
  const result = new Set<string>([fromTaskId])
  let changed = true
  while (changed) {
    changed = false
    for (const task of tasks) {
      if (!result.has(task.id) && task.dependencies.some(d => result.has(d))) {
        result.add(task.id)
        changed = true
      }
    }
  }
  return result
}

/**
 * Reset the target task and all downstream dependents to 'pending'.
 * Does NOT touch tasks outside the dependency graph of fromTaskId.
 * Returns the set of task IDs that were reset.
 */
export async function resetDownstreamTasks(
  db: SupabaseClient,
  fromTaskId: string,
  allTasks: TaskDep[],
): Promise<Set<string>> {
  const toReset = collectDownstreamIds(fromTaskId, allTasks)

  await db.from('change_plan_tasks')
    .update({
      status: 'pending',
      locked_by_run_id: null,
      locked_at: null,
      failure_reason: null,
      blocked_by_task_id: null,
      completed_at: null,
    })
    .in('id', [...toReset])

  return toReset
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm run test -- tests/lib/execution/task-retrigger.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/execution/task-retrigger.ts tests/lib/execution/task-retrigger.test.ts
git commit -m "feat: task-retrigger — graph-based downstream task reset"
```

---

### Task 5: `execution-summary.ts`

**Files:**
- Create: `lib/execution/execution-summary.ts`
- Create: `tests/lib/execution/execution-summary.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/lib/execution/execution-summary.test.ts
import { describe, it, expect } from 'vitest'
import { computeTaskRunSummary } from '@/lib/execution/execution-summary'

interface Task { id: string; status: string }

describe('computeTaskRunSummary', () => {
  it('finalStatus=success when all tasks are done', () => {
    const tasks: Task[] = [
      { id: '1', status: 'done' },
      { id: '2', status: 'done' },
    ]
    const result = computeTaskRunSummary(tasks, 5000)
    expect(result.finalStatus).toBe('success')
    expect(result.completedTasks).toEqual(['1', '2'])
    expect(result.failedTasks).toEqual([])
    expect(result.totalTasks).toBe(2)
    expect(result.durationMs).toBe(5000)
  })

  it('finalStatus=partial when some done and some failed', () => {
    const tasks: Task[] = [
      { id: '1', status: 'done' },
      { id: '2', status: 'failed' },
    ]
    const result = computeTaskRunSummary(tasks, 3000)
    expect(result.finalStatus).toBe('partial')
    expect(result.failedTasks).toEqual(['2'])
  })

  it('finalStatus=failed when no tasks are done', () => {
    const tasks: Task[] = [
      { id: '1', status: 'failed' },
      { id: '2', status: 'blocked' },
    ]
    const result = computeTaskRunSummary(tasks, 1000)
    expect(result.finalStatus).toBe('failed')
    expect(result.blockedTasks).toEqual(['2'])
  })

  it('finalStatus=partial when only blocked tasks remain (some done)', () => {
    const tasks: Task[] = [
      { id: '1', status: 'done' },
      { id: '2', status: 'blocked' },
    ]
    expect(computeTaskRunSummary(tasks, 1000).finalStatus).toBe('partial')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm run test -- tests/lib/execution/execution-summary.test.ts
```

Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement `execution-summary.ts`**

```typescript
// lib/execution/execution-summary.ts
import type { TaskRunSummary } from './execution-types-v2'

interface TaskRow {
  id: string
  status: string
}

/**
 * Compute final TaskRunSummary from the current state of all task rows.
 * Rule: success = all done | partial = ≥1 done + ≥1 failed/blocked | failed = 0 done
 */
export function computeTaskRunSummary(
  tasks: TaskRow[],
  durationMs: number,
): TaskRunSummary {
  const completedTasks = tasks.filter(t => t.status === 'done').map(t => t.id)
  const failedTasks    = tasks.filter(t => t.status === 'failed').map(t => t.id)
  const blockedTasks   = tasks.filter(t => t.status === 'blocked').map(t => t.id)
  const skippedTasks   = tasks.filter(t => t.status === 'skipped' || t.status === 'cancelled').map(t => t.id)

  const finalStatus: TaskRunSummary['finalStatus'] =
    completedTasks.length === tasks.length                        ? 'success'
    : completedTasks.length > 0                                   ? 'partial'
    : 'failed'

  return {
    completedTasks,
    failedTasks,
    blockedTasks,
    skippedTasks,
    totalTasks: tasks.length,
    durationMs,
    finalStatus,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm run test -- tests/lib/execution/execution-summary.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/execution/execution-summary.ts tests/lib/execution/execution-summary.test.ts
git commit -m "feat: execution-summary — compute TaskRunSummary from task states"
```

---

### Task 6: `task-validator.ts`

**Files:**
- Create: `lib/execution/task-validator.ts`

- [ ] **Step 1: Write the implementation**

```typescript
// lib/execution/task-validator.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CodeExecutor } from './executors/code-executor'
import type { ExecutionEnvironment } from './types'
import type { DiagnosticSet } from './execution-types-v2'
import { insertEvent } from './event-emitter'

export interface TaskValidationResult {
  passed: boolean
  typeErrors: DiagnosticSet | null
  testFailures: DiagnosticSet | null
  /** Files added to repair scope because they import from task.files and also have errors */
  expandedFiles: string[]
}

export interface TaskValidatorOptions {
  taskId: string
  taskIndex: number
  taskFiles: string[]
  baselineTypeErrorSigs: Set<string>
  runId: string
  changeId: string
  seq: () => number
}

/**
 * Run scoped validation for a single task.
 *
 * Layer 1 (always): TypeScript compile, errors filtered to task.files
 *                   + adjacent files that import from task.files and also have errors.
 * Layer 2 (always): Tests scoped to task.files via selectTests.
 */
export async function runTaskValidation(
  db: SupabaseClient,
  executor: CodeExecutor,
  env: ExecutionEnvironment,
  opts: TaskValidatorOptions,
): Promise<TaskValidationResult> {
  const { taskId, taskIndex, taskFiles, baselineTypeErrorSigs, runId, changeId, seq } = opts

  await insertEvent(db, {
    runId, changeId, seq: seq(), iteration: taskIndex,
    eventType: 'task.validation_started',
    payload: { taskId, checks: ['tsc', 'tests'] },
  })

  // ── Layer 1: TypeScript compile ───────────────────────────────────────────
  const typeCheck = await executor.runTypeCheck(env)

  const filterNewErrors = (errors: typeof typeCheck.errors) =>
    errors.filter(e => !baselineTypeErrorSigs.has(`${e.file}:${e.line}:${e.message}`))

  const newErrors = filterNewErrors(typeCheck.errors)

  // Errors in task.files
  const taskFileSet = new Set(taskFiles)
  const directErrors = newErrors.filter(e => taskFileSet.has(e.file))

  // File scope expansion: adjacent files that import from task.files and also have errors
  const expandedFiles: string[] = []
  const nonDirectErrors = newErrors.filter(e => !taskFileSet.has(e.file))
  for (const err of nonDirectErrors) {
    // err.message contains "Module ... has no exported member" or import-related messages
    // Include the file if it's not already in task scope
    if (!expandedFiles.includes(err.file)) {
      expandedFiles.push(err.file)
    }
  }

  const allScopedErrors = [...directErrors, ...newErrors.filter(e => expandedFiles.includes(e.file))]

  if (allScopedErrors.length > 0) {
    const diags = allScopedErrors.map(e => ({ file: e.file, line: e.line, message: e.message, code: 'TS' }))
    const typeErrorSet: DiagnosticSet = {
      diagnostics: diags.slice(0, 20),
      totalCount: diags.length,
      truncated: diags.length > 20,
    }
    await insertEvent(db, {
      runId, changeId, seq: seq(), iteration: taskIndex,
      eventType: 'task.validation_failed',
      payload: { taskId, failureType: 'TSC', summary: `${diags.length} type error(s)`, expandedFiles },
    })
    return { passed: false, typeErrors: typeErrorSet, testFailures: null, expandedFiles }
  }

  // ── Layer 2: Scoped tests ─────────────────────────────────────────────────
  const { selectTests } = await import('./test-selector')
  const testScope = await selectTests(db, taskFiles, 'low')
  const testResult = await executor.runTests(env, testScope)

  if (!testResult.passed) {
    const failures = testResult.failures.map((f, i) => ({
      file: f.testName, line: i + 1, message: f.error.slice(0, 200), code: 'TEST',
    }))
    const testFailureSet: DiagnosticSet = {
      diagnostics: failures.slice(0, 20),
      totalCount: failures.length,
      truncated: failures.length > 20,
    }
    await insertEvent(db, {
      runId, changeId, seq: seq(), iteration: taskIndex,
      eventType: 'task.validation_failed',
      payload: { taskId, failureType: testResult.failureType ?? 'TEST', summary: `${failures.length} test failure(s)`, expandedFiles: [] },
    })
    return { passed: false, typeErrors: null, testFailures: testFailureSet, expandedFiles: [] }
  }

  await insertEvent(db, {
    runId, changeId, seq: seq(), iteration: taskIndex,
    eventType: 'task.validation_passed',
    payload: { taskId, durationMs: 0 },
  })

  return { passed: true, typeErrors: null, testFailures: null, expandedFiles: [] }
}
```

- [ ] **Step 2: Verify no compile errors**

```bash
npx tsc --noEmit 2>&1 | grep task-validator
```

Expected: no output (no errors in this file).

- [ ] **Step 3: Commit**

```bash
git add lib/execution/task-validator.ts
git commit -m "feat: task-validator — scoped tsc + test validation per task"
```

---

### Task 7: `task-recovery.ts`

**Files:**
- Create: `lib/execution/task-recovery.ts`

- [ ] **Step 1: Write the implementation**

```typescript
// lib/execution/task-recovery.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIProvider } from '@/lib/ai/provider'
import type { CodeExecutor } from './executors/code-executor'
import type { ExecutionEnvironment } from './types'
import type { DiagnosticSet, TaskBudget } from './execution-types-v2'
import { detectStuck } from './stuck-detector'
import { runInlineRepair } from './inline-repair'
import { runRepairPhase } from './repair-phase'
import { insertEvent } from './event-emitter'
import type { IterationRecord } from './execution-types-v2'

export interface TaskRepairResult {
  success: boolean
  filesPatched: string[]
  stuckReason?: string
}

export interface TaskRepairOptions {
  taskId: string
  taskIndex: number
  runId: string
  changeId: string
  changeIntent: string
  seq: () => number
  budget: TaskBudget
  preExistingFailedTests: Set<string>
}

/**
 * Scoped repair loop for a single task.
 * Reuses inline-repair + repair-phase + stuck-detector.
 * State (iterationHistory) is fresh per task — does not bleed across tasks.
 */
export async function runTaskRepair(
  db: SupabaseClient,
  ai: AIProvider,
  executor: CodeExecutor,
  env: ExecutionEnvironment,
  typeErrors: DiagnosticSet | null,
  testFailures: DiagnosticSet | null,
  opts: TaskRepairOptions,
): Promise<TaskRepairResult> {
  const { taskId, taskIndex, runId, changeId, changeIntent, seq, budget } = opts
  const allFilesPatched: string[] = []
  const iterationHistory: IterationRecord[] = []

  // ── Type error repair ────────────────────────────────────────────────────
  if (typeErrors && typeErrors.totalCount > 0) {
    let inlineRepairCount = 0
    let currentErrors = typeErrors

    while (currentErrors.totalCount > 0 && inlineRepairCount < budget.maxInlineRepairs) {
      await insertEvent(db, {
        runId, changeId, seq: seq(), iteration: taskIndex,
        eventType: 'task.repair_started',
        payload: { taskId, attempt: inlineRepairCount, strategy: 'inline' },
      })

      const attempt = await runInlineRepair(
        db, ai, executor, env, runId, changeId, taskIndex,
        currentErrors, seq, inlineRepairCount,
      )
      allFilesPatched.push(...attempt.filesPatched)
      inlineRepairCount++

      const typeCheck = await executor.runTypeCheck(env)
      const newErrors = typeCheck.errors.map(e => ({
        file: e.file, line: e.line, message: e.message, code: 'TS',
      }))

      await insertEvent(db, {
        runId, changeId, seq: seq(), iteration: taskIndex,
        eventType: 'task.repair_completed',
        payload: { taskId, attempt: inlineRepairCount - 1, success: newErrors.length === 0 },
      })

      if (newErrors.length === 0) return { success: true, filesPatched: allFilesPatched }

      const sigs = newErrors.map(e => `${e.file}:${e.line}:${e.message.slice(0, 40)}`)
      const record: IterationRecord = {
        iteration: inlineRepairCount,
        diagnosticSigs: sigs,
        errorCount: newErrors.length,
        resolvedCount: 0,
        newCount: 0,
        repairedFiles: attempt.filesPatched,
      }
      const stuck = detectStuck(iterationHistory, record, budget)
      if (stuck.stuck) {
        return { success: false, filesPatched: allFilesPatched, stuckReason: stuck.reason ?? undefined }
      }
      iterationHistory.push(record)

      currentErrors = {
        diagnostics: newErrors.slice(0, 20),
        totalCount: newErrors.length,
        truncated: newErrors.length > 20,
      }
    }

    return { success: false, filesPatched: allFilesPatched, stuckReason: 'max_attempts_reached' }
  }

  // ── Test repair ──────────────────────────────────────────────────────────
  if (testFailures && testFailures.totalCount > 0) {
    let repairPhaseCount = 0
    const testRepairHistory: IterationRecord[] = []

    while (repairPhaseCount < budget.maxRepairPhaseAttempts) {
      await insertEvent(db, {
        runId, changeId, seq: seq(), iteration: taskIndex,
        eventType: 'task.repair_started',
        payload: { taskId, attempt: repairPhaseCount, strategy: 'repair_phase' },
      })

      const attempt = await runRepairPhase(
        db, ai, executor, env, runId, changeId, taskIndex,
        testFailures, changeIntent, seq, repairPhaseCount,
      )
      allFilesPatched.push(...attempt.filesPatched)
      repairPhaseCount++

      if (attempt.filesPatched.length === 0) {
        await insertEvent(db, {
          runId, changeId, seq: seq(), iteration: taskIndex,
          eventType: 'task.repair_completed',
          payload: { taskId, attempt: repairPhaseCount - 1, success: false },
        })
        return { success: false, filesPatched: allFilesPatched, stuckReason: 'no_diff_after_repair' }
      }

      const { selectTests } = await import('./test-selector')
      const testScope = await selectTests(db, [], 'low')
      const retest = await executor.runTests(env, testScope)
      const success = retest.passed

      await insertEvent(db, {
        runId, changeId, seq: seq(), iteration: taskIndex,
        eventType: 'task.repair_completed',
        payload: { taskId, attempt: repairPhaseCount - 1, success },
      })

      if (success) return { success: true, filesPatched: allFilesPatched }

      const sigs = retest.failures.map(f => `test:${f.testName}:${f.error.slice(0, 60)}`)
      const record: IterationRecord = {
        iteration: repairPhaseCount,
        diagnosticSigs: sigs,
        errorCount: retest.failures.length,
        resolvedCount: 0,
        newCount: 0,
        repairedFiles: attempt.filesPatched,
      }
      const stuck = detectStuck(testRepairHistory, record, budget)
      if (stuck.stuck) {
        return { success: false, filesPatched: allFilesPatched, stuckReason: stuck.reason ?? undefined }
      }
      testRepairHistory.push(record)
    }

    return { success: false, filesPatched: allFilesPatched, stuckReason: 'max_attempts_reached' }
  }

  return { success: true, filesPatched: [] }
}
```

- [ ] **Step 2: Verify no compile errors**

```bash
npx tsc --noEmit 2>&1 | grep task-recovery
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add lib/execution/task-recovery.ts
git commit -m "feat: task-recovery — scoped repair loop per task (inline + phase + stuck)"
```

---

### Task 8: `task-runner.ts`

**Files:**
- Create: `lib/execution/task-runner.ts`

- [ ] **Step 1: Write the implementation**

`task-runner.ts` orchestrates a single task end-to-end: implement → validate → repair → mark outcome.

```typescript
// lib/execution/task-runner.ts
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIProvider } from '@/lib/ai/provider'
import type { CodeExecutor } from './executors/code-executor'
import type { ExecutionEnvironment, NewFileCreation } from './types'
import type { TaskBudget } from './execution-types-v2'
import { insertEvent } from './event-emitter'
import { isPathAllowed } from './repair-guard'
import { buildTaskImplementationPrompt } from './prompt-builders'
import type { TaskFileContext } from './prompt-builders'
import { acquireTaskLock, releaseTaskDone, releaseTaskFailed } from './task-locker'
import { runTaskValidation } from './task-validator'
import { runTaskRepair } from './task-recovery'

const TASK_FILE_CHAR_CAP = 24_000
const TASK_FILE_CAP = 5

interface PlanTask {
  id: string
  description: string
  order_index: number
  status: string
  files: string[]
  dependencies: string[]
}

export interface TaskRunnerOptions {
  runId: string
  changeId: string
  changeIntent: string
  taskIndex: number
  baselineTypeErrorSigs: Set<string>
  preExistingFailedTests: Set<string>
  budget: TaskBudget
  seq: () => number
  availablePackages: string[]
}

export interface TaskRunResult {
  success: boolean
  filesWritten: string[]
  newFiles: NewFileCreation[]
}

function parseAiJson(content: string): Record<string, unknown> {
  const stripped = content.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim()
  return JSON.parse(stripped)
}

/**
 * Execute one task from start to finish.
 * Caller is responsible for:
 *   - Calling executor.resetIteration(env, acceptedFileWrites) BEFORE calling this
 *   - Adding result.filesWritten to acceptedFileWrites on success
 */
export async function runTask(
  task: PlanTask,
  env: ExecutionEnvironment,
  db: SupabaseClient,
  ai: AIProvider,
  executor: CodeExecutor,
  opts: TaskRunnerOptions,
): Promise<TaskRunResult> {
  const { runId, changeId, changeIntent, taskIndex, baselineTypeErrorSigs, preExistingFailedTests, budget, seq } = opts

  // Acquire lock (conditional — prevents double-execution)
  const locked = await acquireTaskLock(db, task.id, runId)
  if (!locked) {
    return { success: false, filesWritten: [], newFiles: [] }
  }

  await insertEvent(db, {
    runId, changeId, seq: seq(), iteration: taskIndex,
    eventType: 'task.started',
    payload: { taskId: task.id, taskIndex, title: task.description.slice(0, 80) },
  })

  // No files to implement
  const taskFiles = task.files.filter(isPathAllowed).slice(0, TASK_FILE_CAP)
  if (taskFiles.length === 0) {
    await releaseTaskDone(db, task.id)
    await insertEvent(db, {
      runId, changeId, seq: seq(), iteration: taskIndex,
      eventType: 'task.completed',
      payload: { taskId: task.id, durationMs: 0 },
    })
    return { success: true, filesWritten: [], newFiles: [] }
  }

  // ── Implement ────────────────────────────────────────────────────────────
  const fileContexts: TaskFileContext[] = []
  let charBudget = TASK_FILE_CHAR_CAP

  for (const filePath of taskFiles) {
    try {
      const raw = await readFile(join(env.localWorkDir, filePath), 'utf8')
      const chars = Math.min(raw.length, charBudget)
      fileContexts.push({ path: filePath, content: raw.slice(0, chars), isNew: false })
      charBudget -= chars
    } catch {
      fileContexts.push({ path: filePath, content: '', isNew: true })
    }
    if (charBudget <= 0) break
  }

  const prompt = buildTaskImplementationPrompt(
    { description: task.description, intent: changeIntent },
    fileContexts,
  )

  const aiResult = await ai.complete(prompt, { maxTokens: 8192 })
  let parsed: { files?: { path: string; content: string }[]; confidence?: number } = {}
  try { parsed = parseAiJson(aiResult.content) } catch { /* leave empty */ }

  const filesWritten: string[] = []
  const newFiles: NewFileCreation[] = []

  for (const fw of (parsed.files ?? []).filter(f => isPathAllowed(f.path)).slice(0, TASK_FILE_CAP)) {
    if (!fw.content) continue
    const result = await executor.createFile(env, fw.path, fw.content)
    if (result.success) {
      filesWritten.push(fw.path)
      // Track whether it's a new file (for acceptedNewFiles in orchestrator)
      if (fileContexts.find(fc => fc.path === fw.path)?.isNew) {
        newFiles.push({ path: fw.path, content: fw.content })
      }
    }
  }

  if (filesWritten.length === 0) {
    await releaseTaskFailed(db, task.id, 'AI returned no applicable file writes')
    await insertEvent(db, {
      runId, changeId, seq: seq(), iteration: taskIndex,
      eventType: 'task.failed',
      payload: { taskId: task.id, reason: 'no_files_written', stuckReason: null },
    })
    return { success: false, filesWritten: [], newFiles: [] }
  }

  // ── Validate ─────────────────────────────────────────────────────────────
  const validation = await runTaskValidation(db, executor, env, {
    taskId: task.id,
    taskIndex,
    taskFiles,
    baselineTypeErrorSigs,
    runId,
    changeId,
    seq,
  })

  if (validation.passed) {
    await releaseTaskDone(db, task.id)
    await insertEvent(db, {
      runId, changeId, seq: seq(), iteration: taskIndex,
      eventType: 'task.completed',
      payload: { taskId: task.id, durationMs: 0 },
    })
    return { success: true, filesWritten, newFiles }
  }

  // ── Repair ───────────────────────────────────────────────────────────────
  const repair = await runTaskRepair(db, ai, executor, env,
    validation.typeErrors,
    validation.testFailures,
    {
      taskId: task.id,
      taskIndex,
      runId,
      changeId,
      changeIntent,
      seq,
      budget,
      preExistingFailedTests,
    },
  )

  if (repair.success) {
    await releaseTaskDone(db, task.id)
    await insertEvent(db, {
      runId, changeId, seq: seq(), iteration: taskIndex,
      eventType: 'task.completed',
      payload: { taskId: task.id, durationMs: 0 },
    })
    return {
      success: true,
      filesWritten: [...new Set([...filesWritten, ...repair.filesPatched])],
      newFiles,
    }
  }

  const failureReason = repair.stuckReason
    ?? (validation.typeErrors ? `tsc: ${validation.typeErrors.totalCount} errors` : 'tests failed')
  await releaseTaskFailed(db, task.id, failureReason)
  await insertEvent(db, {
    runId, changeId, seq: seq(), iteration: taskIndex,
    eventType: 'task.failed',
    payload: { taskId: task.id, reason: failureReason, stuckReason: repair.stuckReason ?? null },
  })
  return { success: false, filesWritten: [], newFiles: [] }
}
```

- [ ] **Step 2: Verify no compile errors**

```bash
npx tsc --noEmit 2>&1 | grep task-runner
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add lib/execution/task-runner.ts
git commit -m "feat: task-runner — implement+validate+repair loop for a single task"
```

---

### Task 9: Refactor `execution-orchestrator.ts`

**Files:**
- Modify: `lib/execution/execution-orchestrator.ts`

This is the largest change. The iteration loop is replaced with a task loop. Everything before the loop (environment setup, baseline checks) and after (commit, summary) stays substantially the same.

- [ ] **Step 1: Add new imports**

At the top of `lib/execution/execution-orchestrator.ts`, add to the existing import block:

```typescript
import { crashRecoveryCleanup, markTaskBlocked } from './task-locker'
import { runTask } from './task-runner'
import { computeTaskRunSummary } from './execution-summary'
import type { TaskBudget, TaskRunSummary } from './execution-types-v2'
import { DEFAULT_TASK_BUDGET } from './execution-types-v2'
```

- [ ] **Step 2: Update `runExecution` signature to accept `fromTaskId` and `taskBudget`**

Change the function signature from:

```typescript
export async function runExecution(
  changeId: string,
  db: SupabaseClient,
  ai: AIProvider,
  executor: CodeExecutor,
  limits: ExecutionLimits = DEFAULT_LIMITS,
  budget: ExecutionBudget = DEFAULT_BUDGET,
): Promise<void>
```

To:

```typescript
export async function runExecution(
  changeId: string,
  db: SupabaseClient,
  ai: AIProvider,
  executor: CodeExecutor,
  limits: ExecutionLimits = DEFAULT_LIMITS,
  budget: ExecutionBudget = DEFAULT_BUDGET,
  taskBudget: TaskBudget = DEFAULT_TASK_BUDGET,
): Promise<void>
```

- [ ] **Step 3: Replace task loading and the iteration loop**

Find the section starting with `// Load tasks` (around line 217) through the end of the `while` loop (around line 810). Replace everything from the task load through `pendingTasks.length === 0` check with:

```typescript
    // Load tasks — ordered by plan's order_index
    const { data: rawTasks } = await db
      .from('change_plan_tasks')
      .select('id, description, order_index, status, files, dependencies')
      .eq('plan_id', plan.id)
      .order('order_index', { ascending: true })
    const allTasks = (rawTasks ?? []).map(t => ({
      id: t.id as string,
      description: t.description as string,
      order_index: t.order_index as number,
      status: t.status as string,
      files: (t.files ?? []) as string[],
      dependencies: (t.dependencies ?? []) as string[],
    }))

    // Crash recovery: release zombie tasks from dead processes
    await crashRecoveryCleanup(db)

    const plannedFiles = [...new Set(allTasks.flatMap(t => t.files))]
    const branch = (plan as { branch_name?: string }).branch_name ?? `sf/${changeId.slice(0, 8)}-exec`

    const startedAt = Date.now()
    let aiCallCount = 0
    const acceptedFileWrites: { path: string; content: string }[] = []
    const acceptedNewFiles: NewFileCreation[] = []
    const executionScope: ExecutionScope = { plannedFiles, addedViaPropagation: [] }
    let allFilesChanged: string[] = []
    let finalFailureType: string | null = null
    let commitOutcome: CommitOutcome = { type: 'no_commit', reason: 'not started' }
    let runStatus: 'success' | 'wip' | 'budget_exceeded' | 'blocked' | 'cancelled' = 'budget_exceeded'

    const log = makeLogger(db, changeId, runId, () => 0, seq)

    await log('info', `Cloning ${(project as any).repo_url} into container…`)
    env = await executor.prepareEnvironment(
      { id: project.id, repoUrl: (project as any).repo_url ?? '', repoToken: (project as any).repo_token ?? null },
      branch,
      log,
    )
    await log('success', `Environment ready · branch ${branch}`)

    await insertEvent(db, {
      runId, changeId, seq: seq(), iteration: 0,
      eventType: 'execution.started',
      payload: {},
    })

    // Read package.json for context
    let availablePackages: string[] = []
    try {
      const pkgRaw = await readFile(join(env.localWorkDir, 'package.json'), 'utf8')
      const pkg = JSON.parse(pkgRaw)
      availablePackages = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
    } catch { /* best-effort */ }

    // ── Baseline checks (unchanged) ───────────────────────────────────────
    const baselineTestScope = await selectTests(db, [], (change as { risk_level: string | null }).risk_level ?? 'low')
    const baselineResult = await runBaselineRepair(db, ai, executor, env, runId, changeId, baselineTestScope, log, seq)

    if (baselineResult.status === 'blocked') {
      finalFailureType = `baseline: test infrastructure unresolvable [${baselineResult.category}]`
      await log('error', `Execution blocked — test infrastructure cannot be made testable`)
      await insertEvent(db, { runId, changeId, seq: seq(), iteration: 0, eventType: 'execution.blocked', payload: { reason: finalFailureType } })
      await createBaselineBlockedSuggestion(db, projectId, changeId, baselineResult.category!)
      throw Object.assign(new Error(finalFailureType), { executionBlocked: true })
    }

    const preExistingFailedTests = baselineResult.preExistingFailedTests
    let testabilityStatus: TestabilityStatus =
      baselineResult.status === 'clean'        ? 'full' :
      baselineResult.status === 'repaired'     ? 'full_repaired' :
      baselineResult.status === 'pre_existing' ? 'partial' : 'full'

    const baselineTscResult = await executor.runTypeCheck(env)
    const baselineTypeErrorSigs = new Set(
      baselineTscResult.errors.map(e => `${e.file}:${e.line}:${e.message}`)
    )

    // ── Task loop ─────────────────────────────────────────────────────────
    await log('info', `Execution started — ${allTasks.length} task(s)`)

    const doneById = new Map<string, boolean>()  // taskId → success

    for (const task of allTasks) {
      // Skip already-terminal tasks (from a previous partial run)
      if (task.status === 'done') { doneById.set(task.id, true); continue }
      if (['blocked', 'skipped', 'cancelled'].includes(task.status)) continue
      if (task.status === 'failed') continue  // will be re-run if retriggered

      // Dependency check
      const failedDep = task.dependencies.find(depId => {
        const depTask = allTasks.find(t => t.id === depId)
        return !depTask || !['done'].includes(depTask.status) && !doneById.get(depId)
      })
      if (failedDep) {
        await markTaskBlocked(db, task.id, failedDep)
        await insertEvent(db, {
          runId, changeId, seq: seq(), iteration: task.order_index,
          eventType: 'task.blocked',
          payload: { taskId: task.id, blockedByTaskId: failedDep },
        })
        await log('info', `Task ${task.order_index + 1} blocked — dependency ${failedDep} not done`)
        continue
      }

      // Check cancellation
      if (await isCancellationRequested(db, runId)) {
        runStatus = 'cancelled'
        break
      }

      // Re-apply accepted patches to clean branch state before this task
      await executor.resetIteration(env, acceptedFileWrites)
      for (const nf of acceptedNewFiles) {
        await executor.createFile(env, nf.path, nf.content)
      }

      await log('verbose', `Task ${task.order_index + 1}/${allTasks.length}: ${task.description}`)

      const result = await runTask(task, env, db, ai, executor, {
        runId,
        changeId,
        changeIntent: (change as { intent: string }).intent,
        taskIndex: task.order_index,
        baselineTypeErrorSigs,
        preExistingFailedTests,
        budget: taskBudget,
        seq,
        availablePackages,
      })

      aiCallCount++

      if (result.success) {
        doneById.set(task.id, true)
        // Track accepted writes so subsequent tasks and the final commit see them
        for (const path of result.filesWritten) {
          // Find content from the written file (read from disk)
          try {
            const content = await readFile(join(env.localWorkDir, path), 'utf8')
            const existing = acceptedFileWrites.findIndex(fw => fw.path === path)
            if (existing >= 0) {
              acceptedFileWrites[existing]!.content = content
            } else {
              acceptedFileWrites.push({ path, content })
            }
          } catch { /* file not readable — skip tracking */ }
        }
        acceptedNewFiles.push(...result.newFiles)
        allFilesChanged = [...new Set([...allFilesChanged, ...result.filesWritten])]
        await log('success', `Task ${task.order_index + 1} done`)
      } else {
        await log('error', `Task ${task.order_index + 1} failed`)
        finalFailureType = `task_${task.order_index + 1}: ${task.description.slice(0, 60)}`
      }

      // Duration limit
      if (Date.now() - startedAt > limits.maxDurationMs) break
    }

    // Reload task statuses for summary (DB is source of truth)
    const { data: finalTaskRows } = await db
      .from('change_plan_tasks')
      .select('id, status')
      .eq('plan_id', plan.id)
    const taskSummary = computeTaskRunSummary(finalTaskRows ?? [], Date.now() - startedAt)
    const fullSuccess = taskSummary.finalStatus === 'success'
```

After this block, the rest of the function (commit policy, confidence, final log, `enrichSnapshotWithRetry`, `finalizeRun`) stays the same. The one change is how `runStatus` and `fullSuccess` are determined — replace the old `if (fullSuccess) runStatus = 'success'` block with:

```typescript
    if (!cancelled) {
      if (taskSummary.finalStatus === 'success') runStatus = 'success'
      else if (commitOutcome.type === 'wip') runStatus = 'wip'
      else runStatus = 'budget_exceeded'
    }
```

And in the `ExecutionSummary` object, add `taskRunSummary` to the summary written to `execution_runs`:

```typescript
    const summary: ExecutionSummary & { taskRunSummary?: TaskRunSummary } = {
      status: runStatus,
      // ... existing fields ...
      taskRunSummary: taskSummary,
    }
```

- [ ] **Step 4: Delete now-unused variables**

Remove the old `ExecutionState` interface and `state` object (no longer needed). Also remove `iterationHistory`, `pendingTasks`, `firstIterationErrorSigs`, `lastIterationErrorSigs` — these were iteration-loop state. The `allFilesChanged`, `repairsAttempted`, etc. are replaced by task-level tracking.

- [ ] **Step 5: Verify compile**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Run existing tests**

```bash
npm run test -- tests/lib/execution/execution-orchestrator.test.ts
```

Expected: existing tests pass (they test baseline/commit logic which is unchanged).

- [ ] **Step 7: Commit**

```bash
git add lib/execution/execution-orchestrator.ts
git commit -m "feat: execution-orchestrator — replace iteration loop with task-by-task loop"
```

---

### Task 10: Update `execute/route.ts`

**Files:**
- Modify: `app/api/change-requests/[id]/execute/route.ts`

- [ ] **Step 1: Add `fromTaskId` support to the POST handler**

Replace the `POST` handler body after the concurrency guard with the following. The key additions are:
1. Parse optional `fromTaskId` from request body
2. If `fromTaskId`: use `resetDownstreamTasks` instead of resetting all tasks
3. Pass `fromTaskId` info through to `runExecution`

```typescript
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: change } = await db
    .from('change_requests')
    .select('id, status, projects!inner(owner_id, repo_url, repo_token)')
    .eq('id', id)
    .eq('projects.owner_id', user.id)
    .single()

  if (!change) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const project = change.projects as unknown as { owner_id: string; repo_url: string | null; repo_token: string | null }
  if (!project.repo_url) {
    return NextResponse.json({ error: 'No repository configured', detail: 'Set a repository URL in Project Settings before executing.' }, { status: 422 })
  }
  if (!project.repo_token) {
    return NextResponse.json({ error: 'No access token configured', detail: 'Set a GitHub access token in Project Settings → Repository before executing.' }, { status: 422 })
  }

  if (!['planned', 'failed', 'executing', 'review', 'done'].includes(change.status)) {
    return NextResponse.json({ error: `Cannot execute from status '${change.status}'.` }, { status: 409 })
  }

  // Parse optional body
  let fromTaskId: string | null = null
  try {
    const body = await req.json().catch(() => ({}))
    fromTaskId = body?.fromTaskId ?? null
  } catch { /* no body */ }

  // Verify approved plan
  const { data: plan } = await db
    .from('change_plans')
    .select('id, status')
    .eq('change_id', id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!plan || plan.status !== 'approved') {
    return NextResponse.json({ error: 'No approved plan found' }, { status: 409 })
  }

  // Concurrency guard
  const { data: activeRun } = await db
    .from('execution_runs')
    .select('id')
    .eq('change_id', id)
    .eq('status', 'running')
    .limit(1)
    .maybeSingle()

  if (activeRun) {
    return NextResponse.json({ error: 'An execution is already in progress for this change.' }, { status: 409 })
  }

  const docker = await checkDocker()
  if (!docker.ok) {
    return NextResponse.json({ error: 'Docker is not running', detail: docker.error }, { status: 503 })
  }

  const adminDb = createAdminClient()

  const clientRequestId = req.headers.get('X-Client-Request-Id')
  if (clientRequestId) {
    await adminDb.from('change_requests').update({ client_request_id: clientRequestId }).eq('id', id)
  }

  if (fromTaskId) {
    // Retrigger: reset target task + downstream dependents only
    // Load all tasks for graph traversal
    const { data: allTasks } = await adminDb
      .from('change_plan_tasks')
      .select('id, dependencies')
      .eq('plan_id', plan.id)

    const { resetDownstreamTasks } = await import('@/lib/execution/task-retrigger')
    await resetDownstreamTasks(adminDb, fromTaskId, allTasks ?? [])

    // Clear only execution_runs (to allow a new run) — keep snapshots/logs for audit
    await adminDb.from('execution_runs').delete().eq('change_id', id)
  } else {
    // Full re-run: clear all execution history
    await adminDb.from('execution_runs').delete().eq('change_id', id)
    await adminDb.from('execution_snapshots').delete().eq('change_id', id)
    await adminDb.from('execution_trace').delete().eq('change_id', id)
    await adminDb.from('execution_logs').delete().eq('change_id', id)

    // Reset all tasks to pending
    await adminDb.from('change_plan_tasks')
      .update({ status: 'pending', locked_by_run_id: null, locked_at: null, failure_reason: null, blocked_by_task_id: null, completed_at: null })
      .eq('plan_id', plan.id)
  }

  const ai = getProvider()
  const executor = new DockerExecutor()

  runExecution(id, adminDb, ai, executor).catch(err =>
    console.error(`[execution-orchestrator] change ${id} failed:`, err)
  )

  return NextResponse.json({ changeId: id, status: 'executing' }, { status: 202 })
}
```

- [ ] **Step 2: Add missing import**

At the top of the file add:

```typescript
import { runExecution } from '@/lib/execution/execution-orchestrator'
```

(It's already there — verify it's present, no change needed.)

- [ ] **Step 3: Verify compile**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/api/change-requests/\[id\]/execute/route.ts
git commit -m "feat: execute route — add fromTaskId retrigger support"
```

---

### Task 11: Update `execute/events/route.ts`

**Files:**
- Modify: `app/api/change-requests/[id]/execute/events/route.ts`

The events endpoint is what the UI polls. Add task statuses to the response so the UI can display per-task state without a separate endpoint.

- [ ] **Step 1: Add task status query**

Replace the current handler with:

```typescript
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: change } = await db
    .from('change_requests')
    .select('id, status, projects!inner(owner_id)')
    .eq('id', id)
    .eq('projects.owner_id', user.id)
    .single()

  if (!change) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: run } = await db
    .from('execution_runs')
    .select('id, status, summary, started_at, ended_at, cancellation_requested')
    .eq('change_id', id)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!run) {
    return NextResponse.json({ run: null, events: [], tasks: [], changeStatus: change.status })
  }

  const { data: events } = await db
    .from('execution_events')
    .select('id, seq, iteration, event_type, phase, payload, created_at')
    .eq('run_id', run.id)
    .order('seq', { ascending: true })

  // Load latest plan's tasks for status display
  const { data: latestPlan } = await db
    .from('change_plans')
    .select('id')
    .eq('change_id', id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const { data: tasks } = latestPlan
    ? await db
        .from('change_plan_tasks')
        .select('id, description, order_index, status, files, failure_reason, blocked_by_task_id, completed_at')
        .eq('plan_id', latestPlan.id)
        .order('order_index', { ascending: true })
    : { data: [] }

  return NextResponse.json({
    run: {
      id: run.id,
      status: run.status,
      summary: run.summary,
      startedAt: run.started_at,
      endedAt: run.ended_at,
      cancellationRequested: run.cancellation_requested,
    },
    events: events ?? [],
    tasks: tasks ?? [],
    changeStatus: change.status,
  })
}
```

- [ ] **Step 2: Verify compile**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/api/change-requests/\[id\]/execute/events/route.ts
git commit -m "feat: execute events route — include task statuses in response"
```

---

### Task 12: Update `execution-view.tsx`

**Files:**
- Modify: `app/projects/[id]/changes/[changeId]/execution/execution-view.tsx`

Replace iteration cards with task cards. Tasks are fetched via the events endpoint (already includes `tasks[]` after Task 11).

- [ ] **Step 1: Read the current file to understand its structure**

Read `app/projects/[id]/changes/[changeId]/execution/execution-view.tsx` fully before making changes.

- [ ] **Step 2: Add task state types**

Near the top of the component file, after existing interfaces, add:

```typescript
interface TaskRow {
  id: string
  description: string
  order_index: number
  status: string
  failure_reason: string | null
  blocked_by_task_id: string | null
  completed_at: string | null
}
```

- [ ] **Step 3: Add task state and update polling**

Add `tasks` state initialized from the events response, and update the polling effect to also set tasks:

```typescript
const [tasks, setTasks] = useState<TaskRow[]>([])

// In the polling useEffect, after setting events:
if (data.tasks) setTasks(data.tasks)
```

- [ ] **Step 4: Add `getTaskUiState` helper**

Add this helper before the JSX return:

```typescript
function getTaskUiState(
  task: TaskRow,
  events: { event_type: string; payload: Record<string, unknown> }[],
): 'queued' | 'running' | 'repairing' | 'done' | 'failed' | 'blocked' {
  if (task.status === 'done') return 'done'
  if (task.status === 'failed') return 'failed'
  if (task.status === 'blocked') return 'blocked'

  // Derive live state from event stream
  const taskEvents = events.filter(e => (e.payload as { taskId?: string }).taskId === task.id)
  const lastEvent = taskEvents[taskEvents.length - 1]

  if (!lastEvent) return 'queued'
  if (lastEvent.event_type === 'task.repair_started') return 'repairing'
  if (lastEvent.event_type === 'task.started' || lastEvent.event_type === 'task.validation_started') return 'running'
  return 'queued'
}
```

- [ ] **Step 5: Replace iteration cards with task cards**

Find the section that renders iteration cards (look for `iterationGroups` or iteration-related JSX). Replace it with:

```tsx
{/* Task list */}
<div className="divide-y divide-white/5">
  {tasks.length === 0 && (
    <p className="px-5 py-8 text-sm text-slate-500 text-center">No tasks yet.</p>
  )}
  {tasks.map(task => {
    const uiState = getTaskUiState(task, events)
    const taskEvents = events.filter(e =>
      (e.payload as { taskId?: string }).taskId === task.id
    )

    const statusColors: Record<string, string> = {
      done: 'text-green-400 bg-green-400/10',
      failed: 'text-red-400 bg-red-400/10',
      blocked: 'text-slate-500 bg-slate-500/10',
      running: 'text-indigo-400 bg-indigo-400/10',
      repairing: 'text-amber-400 bg-amber-400/10',
      queued: 'text-slate-600 bg-slate-600/10',
    }

    return (
      <div key={task.id} className="px-5 py-4">
        <div className="flex items-start gap-3">
          <span className={`mt-0.5 px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider ${statusColors[uiState] ?? statusColors.queued}`}>
            {uiState}
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-slate-200 leading-snug">{task.description}</p>

            {/* Blocked reason */}
            {uiState === 'blocked' && task.blocked_by_task_id && (
              <p className="mt-1 text-xs text-slate-500">
                Blocked by task {tasks.findIndex(t => t.id === task.blocked_by_task_id) + 1}
              </p>
            )}

            {/* Failure reason + retrigger */}
            {uiState === 'failed' && (
              <div className="mt-2 flex items-start gap-3">
                {task.failure_reason && (
                  <p className="text-xs text-red-400 font-mono leading-snug">{task.failure_reason}</p>
                )}
                <button
                  onClick={async () => {
                    await fetch(`/api/change-requests/${changeId}/execute`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ fromTaskId: task.id }),
                    })
                  }}
                  className="flex-shrink-0 px-3 py-1 rounded border border-white/10 text-xs text-slate-400 hover:text-slate-200 font-bold transition-colors"
                >
                  Retrigger
                </button>
              </div>
            )}

            {/* Inline events for active task */}
            {(uiState === 'running' || uiState === 'repairing') && taskEvents.length > 0 && (
              <div className="mt-2 space-y-0.5">
                {taskEvents.slice(-3).map(e => (
                  <p key={`${e.event_type}-${e.payload}`} className="text-[11px] text-slate-600 font-mono">
                    {e.event_type}
                  </p>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    )
  })}
</div>
```

Note: `changeId` in the Retrigger button must come from component props. Verify the prop is available.

- [ ] **Step 6: Add run summary footer**

After the task list, add a summary section that shows when `run?.summary?.taskRunSummary` is available:

```tsx
{run?.summary?.taskRunSummary && (
  <div className="px-5 py-4 border-t border-white/5 flex items-center gap-4 text-xs text-slate-500">
    <span className={`font-bold ${
      run.summary.taskRunSummary.finalStatus === 'success' ? 'text-green-400' :
      run.summary.taskRunSummary.finalStatus === 'partial' ? 'text-amber-400' :
      'text-red-400'
    }`}>
      {run.summary.taskRunSummary.finalStatus.toUpperCase()}
    </span>
    <span>{run.summary.taskRunSummary.completedTasks.length}/{run.summary.taskRunSummary.totalTasks} tasks completed</span>
    {run.summary.taskRunSummary.failedTasks.length > 0 && (
      <span className="text-red-400">{run.summary.taskRunSummary.failedTasks.length} failed</span>
    )}
    {run.summary.taskRunSummary.blockedTasks.length > 0 && (
      <span>{run.summary.taskRunSummary.blockedTasks.length} blocked</span>
    )}
  </div>
)}
```

- [ ] **Step 7: Verify no type errors**

```bash
npx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 8: Run full test suite**

```bash
npm run test
```

Expected: all existing tests pass.

- [ ] **Step 9: Commit**

```bash
git add app/projects/\[id\]/changes/\[changeId\]/execution/execution-view.tsx
git commit -m "feat: execution-view — replace iteration cards with task cards"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| DB: dependencies, locked_at, completed_at, failure_reason, blocked_by_task_id | Task 1 |
| New event types in EVENT_TYPES | Task 2 |
| TaskRunSummary, TaskBudget types | Task 2 |
| task-locker: acquire/release/crash recovery | Task 3 |
| Conditional UPDATE WHERE status='pending' | Task 3 |
| task-retrigger: graph-based collectDownstreamIds | Task 4 |
| execution-summary: success/partial/failed rules | Task 5 |
| task-validator: base layer (tsc) + file scope expansion | Task 6 |
| task-recovery: scoped inline+phase+stuck repair | Task 7 |
| task-runner: implement+validate+repair+mark | Task 8 |
| Orchestrator: crash recovery cleanup at startup | Task 9 |
| Orchestrator: dependency check per task | Task 9 |
| Orchestrator: resetIteration before each task | Task 9 |
| Orchestrator: acceptedFileWrites accumulation | Task 9 |
| fromTaskId retrigger API | Task 10 |
| Full reset vs partial retrigger reset | Task 10 |
| Events endpoint: include task statuses | Task 11 |
| UI: task cards, status pills, blocked reason | Task 12 |
| UI: Retrigger button on failed tasks | Task 12 |
| UI: run summary footer with finalStatus | Task 12 |
| Crash recovery: 10-min zombie cleanup | Task 3 |
| Prompt contract: existing buildTaskImplementationPrompt | Task 8 |

**Type consistency check:**
- `TaskRunSummary` defined in Task 2, used in Task 5 (computeTaskRunSummary), Task 9 (orchestrator), Task 12 (UI) ✓
- `TaskBudget` / `DEFAULT_TASK_BUDGET` defined in Task 2, used in Task 7 (task-recovery), Task 8 (task-runner), Task 9 (orchestrator) ✓
- `acquireTaskLock` / `releaseTaskDone` / `releaseTaskFailed` / `markTaskBlocked` / `crashRecoveryCleanup` defined in Task 3, used in Task 8 (task-runner) and Task 9 (orchestrator) ✓
- `collectDownstreamIds` / `resetDownstreamTasks` defined in Task 4, used in Task 10 (route) ✓
- `computeTaskRunSummary` defined in Task 5, used in Task 9 ✓
- `runTaskValidation` defined in Task 6, used in Task 8 ✓
- `runTaskRepair` defined in Task 7, used in Task 8 ✓
- `runTask` defined in Task 8, used in Task 9 ✓

**No placeholders present.** ✓
