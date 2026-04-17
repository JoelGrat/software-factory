# Task-Based Execution Design

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the iteration-based execution loop with a task-by-task loop that implements one plan task at a time, validates immediately, repairs if needed, and marks done/failed before advancing — with the ability to retrigger individual failed tasks.

---

## Context

The current `runExecution` loop in `lib/execution/execution-orchestrator.ts` runs all pending tasks in a single iteration pass, then validates the entire workspace. This produces chaotic repair cycles and makes partial failures unrecoverable without a full re-run.

The new model runs one task at a time: implement → validate (scoped) → repair (scoped) → mark outcome → next task. Tasks with failed dependencies are blocked automatically. Failed tasks can be retriggered without resetting prior work.

---

## Module Boundaries

The orchestrator delegates to focused modules. Each module has one job.

```
lib/execution/
  execution-orchestrator.ts   → top-level loop, environment setup, final summary
  task-runner.ts              → executes one task (implement → validate → repair → mark)
  task-validator.ts           → runs base + declared validations, expands file scope
  task-recovery.ts            → scoped repair loop (wraps inline-repair, repair-phase, stuck-detector)
  task-locker.ts              → DB lock acquire/release, crash recovery cleanup
  task-retrigger.ts           → graph-based downstream reset logic
  execution-summary.ts        → computes TaskRunSummary from final task states
  [existing files unchanged]  → inline-repair.ts, repair-phase.ts, stuck-detector.ts, docker-executor.ts, ...
```

---

## Architecture

### 1. Task Loop

`runExecution` restructured:

```
startup: crash recovery cleanup (release zombie in_progress tasks older than 10min)
setup environment (clone repo, install, baseline checks) — unchanged

for task of orderedTasks:
  if task.status === 'done'    → skip
  if task.status === 'blocked' → skip
  if task.status === 'skipped' → skip
  if any dependency not 'done' → mark blocked (with blockedByTaskId), skip

  lock = taskLocker.acquire(taskId, runId)
  if !lock                     → skip (concurrent run took it)

  emit task.started
  task-runner.runTask(task, env, db, ai, executor)
  // task-runner marks done or failed, emits events

emit final summary (execution-summary.ts)
update execution_run.summary + change_request.status
```

### 2. Task Status Model

Full lifecycle:

| status | meaning |
|---|---|
| `pending` | ready to run |
| `in_progress` | currently executing |
| `retrying` | repair loop active (sub-state of in_progress, reflected in events) |
| `done` | completed successfully |
| `failed` | exhausted repair attempts |
| `blocked` | a dependency failed or is blocked |
| `skipped` | explicitly skipped (e.g. user cancelled mid-run) |
| `cancelled` | run cancelled before task started |

`retrying` is an event-stream state, not a DB column value. In the DB, the task stays `in_progress` during repair. The event `task.repair_started` signals the UI to show "repairing". This avoids a DB update per repair attempt while keeping the UI accurate.

### 3. Task Lock Model (`task-locker.ts`)

**Acquire:**

```sql
UPDATE change_plan_tasks
SET status = 'in_progress',
    locked_by_run_id = $runId,
    locked_at = now()
WHERE id = $taskId
  AND status = 'pending'
RETURNING id
```

Returns the updated row. If 0 rows: lock not acquired — skip task.

**Release on failure:**

```sql
UPDATE change_plan_tasks
SET status = 'failed',
    failure_reason = $reason,
    locked_by_run_id = null
WHERE id = $taskId
```

**Crash recovery (run at execution startup):**

```sql
UPDATE change_plan_tasks
SET status = 'pending',
    locked_by_run_id = null,
    locked_at = null
WHERE status = 'in_progress'
  AND locked_at < now() - interval '10 minutes'
```

This releases tasks that were locked by a process that died. Safe to run unconditionally at startup since a live executor will re-acquire the lock.

### 4. Dependency Model

Each task row has `dependencies uuid[]` (task IDs that must be `done` before this task runs).

At task start: if any dependency has status `failed` or `blocked`, mark this task:

```sql
UPDATE change_plan_tasks
SET status = 'blocked',
    blocked_by_task_id = $firstFailedDepId
WHERE id = $taskId
```

Dependencies are populated at plan projection time by `rebuildTaskProjection`. For v1: sequential — task N depends on task N-1. The planner can declare explicit parallel groups in a future iteration.

### 5. Validation (`task-validator.ts`)

Two layers, always run in order:

**Layer 1 — Base engine validations** (always, regardless of planner):
1. Lock ownership check: verify `locked_by_run_id === currentRunId` (detect concurrent interference)
2. Workspace integrity: `git status --porcelain` confirms we have a clean starting point
3. TypeScript compile: `tsc --noEmit`, filter to errors in `task.files` only (pre-existing errors excluded)

**Layer 2 — Declared task validations** (from `task.playbook.validation[]` in plan_json):
- Each entry specifies a check type and parameters
- Check types: `tests`, `file_exists`, `command`
- For `tests`: derive `TestScope` from `task.files` using existing scope inference; run scoped test files
- For `file_exists`: verify the file was created at the declared path
- For `command`: run the declared command, assert exit code 0

The planner is the source of truth for what a task must prove. The base engine layer is a safety net that always runs.

**File scope expansion:**

`task.files` is the declared scope. During validation, if compile errors appear in files _not_ in `task.files` that import a file that _is_ in `task.files`, those adjacent files are added to the repair scope automatically. This is discovered from the error output, not pre-computed. The expanded scope is logged in the `task.validation_failed` event payload.

### 6. AI Prompt Contract

**Input to AI for task implementation:**

```typescript
interface TaskImplementationInput {
  task: {
    id: string
    title: string
    description: string
    files: string[]                       // resolved file list
    playbook: {
      implementation_notes: string
      code_snippets: CodeSnippet[]
      commands: string[]
      rollback: string[]
    }
  }
  plan: {
    goal: string
    summary: { architecture: string; tech_stack: string }
    file_map: { create: string[]; rewrite: string[]; delete: string[] }
  }
  workspace: {
    existingFiles: { path: string; content: string }[]   // current branch state for task.files + imports
  }
}
```

**Expected output from AI:**

```typescript
interface TaskImplementationOutput {
  patches: Array<{
    file: string
    content: string          // full file content (not a diff)
  }>
  commands: string[]         // commands to run after patching (optional)
  confidence: number         // 0–1
  rationale: string          // one sentence
}
```

If `confidence < 0.3`, log a warning event but still apply patches and proceed to validation. Confidence gates are not enforced here — validation is the real gate.

### 7. Scoped Repair Loop (`task-recovery.ts`)

Wraps existing mechanisms, scoped to the current task:

1. **inline-repair** — type errors in `task.files` (plus expansion files if any)
2. **repair-phase** — test failures in task-derived test scope
3. **stuck-detector** — same logic; `IterationRecord` is per-task (reset between tasks, not shared)

Budget per task (new `TaskBudget`, separate from old global budget):

```typescript
interface TaskBudget {
  maxInlineRepairs: number        // default: 3
  maxRepairPhaseAttempts: number  // default: 2
}
```

On each repair attempt, emit `task.repair_started` (→ UI shows "repairing"). On completion, emit `task.repair_completed` with `success: boolean`.

### 8. Retrigger (`task-retrigger.ts`)

**API:** `POST /api/change-requests/:id/execute` with optional `{ fromTaskId: string }`.

**When `fromTaskId` is provided**, run a graph-based downstream reset before starting execution:

```
function collectReset(taskId):
  add taskId to resetSet
  for each task where taskId ∈ task.dependencies:
    if task.status in ('failed', 'blocked', 'done'):
      collectReset(task.id)   // recurse

resetSet = collectReset(fromTaskId)

UPDATE change_plan_tasks
SET status = 'pending',
    locked_by_run_id = null,
    failure_reason = null,
    blocked_by_task_id = null
WHERE id IN (resetSet)
```

This resets the target task AND all direct/transitive dependents regardless of `order_index`. Tasks not in the dependency graph of `fromTaskId` are untouched — their `done` state is preserved.

No branch reset. The branch retains accepted patches from tasks not in `resetSet`.

**When no `fromTaskId`:** reset all tasks to `pending`, full re-run (existing behaviour).

### 9. Final Status Rules (`execution-summary.ts`)

After the loop:

| finalStatus | condition |
|---|---|
| `success` | all tasks `done` |
| `partial` | ≥1 task `done`, ≥1 task `failed` or `blocked` |
| `failed` | 0 tasks `done` |

```typescript
interface TaskRunSummary {
  completedTasks: string[]    // task IDs
  failedTasks: string[]
  blockedTasks: string[]
  skippedTasks: string[]
  totalTasks: number
  durationMs: number
  finalStatus: 'success' | 'partial' | 'failed'
}
```

Persisted to `execution_runs.summary` (extend existing shape with `taskRunSummary` field).

`change_request.status` mapping:
- `success` → `review`
- `partial` → `review` (user reviews what was done)
- `failed` → `failed`

### 10. Event Model

New `event_type` values for `execution_events`. All include `taskId` in payload.

| event_type | payload |
|---|---|
| `task.started` | `{ taskId, taskIndex, title }` |
| `task.validation_started` | `{ taskId, checks: string[] }` |
| `task.validation_passed` | `{ taskId, durationMs }` |
| `task.validation_failed` | `{ taskId, failureType, summary, expandedFiles?: string[] }` |
| `task.repair_started` | `{ taskId, attempt, strategy }` |
| `task.repair_completed` | `{ taskId, attempt, success }` |
| `task.completed` | `{ taskId, durationMs }` |
| `task.failed` | `{ taskId, reason, stuckReason }` |
| `task.blocked` | `{ taskId, blockedByTaskId }` |

Existing events (`repair.inline.*`, `repair.phase.*`, `iteration.stuck`) continue to be emitted, with `taskId` added to their payload. The `iteration` field is repurposed as `taskIndex`.

---

## Database Schema Changes

New migration:

```sql
-- Task dependencies (array of task IDs that must be done first)
ALTER TABLE change_plan_tasks
  ADD COLUMN IF NOT EXISTS dependencies uuid[] NOT NULL DEFAULT '{}';

-- Lock timing (for crash recovery)
ALTER TABLE change_plan_tasks
  ADD COLUMN IF NOT EXISTS locked_at timestamptz;

-- Completion timestamp
ALTER TABLE change_plan_tasks
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

-- Failure detail
ALTER TABLE change_plan_tasks
  ADD COLUMN IF NOT EXISTS failure_reason text;

-- Which dependency caused this task to be blocked
ALTER TABLE change_plan_tasks
  ADD COLUMN IF NOT EXISTS blocked_by_task_id uuid REFERENCES change_plan_tasks(id);

-- Index: find all tasks blocked by a given task (for retrigger graph traversal)
CREATE INDEX IF NOT EXISTS change_plan_tasks_blocked_by_idx
  ON change_plan_tasks (blocked_by_task_id)
  WHERE blocked_by_task_id IS NOT NULL;

-- Index: crash recovery query (find stuck in_progress tasks)
CREATE INDEX IF NOT EXISTS change_plan_tasks_locked_at_idx
  ON change_plan_tasks (locked_at)
  WHERE status = 'in_progress';
```

The `status` constraint in migration 027 already includes `blocked` and `skipped` and `cancelled`. No change needed there.

---

## UI Changes (`execution-view.tsx`)

Replace iteration cards with task cards. Task card states:

| UI state | when |
|---|---|
| waiting | `pending`, has dependencies not yet done |
| queued | `pending`, no blocking dependencies |
| running | `in_progress`, no repair event since last `task.started` |
| repairing | `in_progress`, `task.repair_started` seen, no `task.repair_completed` yet |
| retriggering | between retrigger API call and next `task.started` event |
| done | `done` |
| failed | `failed` — show failure_reason + **Retrigger** button |
| blocked | `blocked` — show "Blocked by: [Task N title]" |

The UI derives these states from the event stream plus the task row status. No new polling endpoint needed — `execution_events` already streams all state transitions.

Final summary section: completed / failed / blocked counts, `finalStatus` badge, duration.

---

## What Does Not Change

- Docker executor: setup, file I/O, git operations, commit/push
- `inline-repair.ts`, `repair-phase.ts`, `stuck-detector.ts` interfaces
- `execution_events` table structure
- Baseline checks before the loop (pre-existing error snapshot, baseline test repair)
- Heartbeat monitor, `execution_runs` concurrency guard
- Commit logic (single commit at end of execution, not per-task)
- Polling mechanism in `execution-view.tsx`

---

## Out of Scope (v1)

- Parallel task execution
- Optional vs required task flags
- Per-task branch checkpoints
- Planner writing explicit non-sequential dependencies
