# Agent Loop Design

**Date:** 2026-03-27
**Status:** Approved
**Builds on:** 2026-03-25-requirements-intelligence-design-v2.md

---

## Overview

This document specifies the agentic code generation engine for Software Factory. It extends the existing requirements intelligence pipeline with three agent loops and four UI screens, turning approved requirements into working code on a git branch — with human approval gates at planning and review.

The core thesis: *requirements quality gates already exist; this adds the execution engine that uses them.*

---

## Full Pipeline

```
Paste unstructured text
        │
        ▼
┌─────────────────┐
│ Requirements    │  Agent loop: parse → self-critique → re-parse
│ Loop            │  until confident. Max 3 iterations.
└────────┬────────┘
         │ human reviews + approves requirements
         ▼
┌─────────────────┐
│ Planning        │  Agent loop: file tree → read files → plan
│ Loop            │  → self-review → refine. Max 2 iterations.
└────────┬────────┘
         │
         ▼
┌─────────────────┐  ← HUMAN GATE 1
│ Plan Screen     │  tasks list + files to change + APPROVE
└────────┬────────┘
         │ approved
         ▼
┌─────────────────┐
│ Execution       │  Agent loop: code → apply → test → feedback
│ Loop            │  Max 10 iterations. Live logs + iteration counter.
└────────┬────────┘
         │ tests passing
         ▼
┌─────────────────┐  ← HUMAN GATE 2
│ Review Screen   │  code diff + test results + APPROVE / RETRY
└────────┬────────┘
         │ approved
         ▼
   Git branch created (sf/<requirement-id>-<slug>)
```

**Job state machine** (job is created after requirements are approved):
```
pending → plan_loop → awaiting_plan_approval → coding → awaiting_review → done
                                               ↑________________| (retry)
                                               failed (max iterations exceeded)
                                               cancelled (user cancels mid-run)
```

**Note:** The requirements loop is an enhancement to the existing requirements pipeline (`lib/requirements/`), not part of the job. It replaces the current single-pass `parser.ts` call with a multi-iteration agent loop. A job is created only after `requirement_set.status = ready_for_dev`.

---

## Architecture

### New Module: `lib/agent/`

A self-contained module. Connects to the existing system at one seam: `requirement_set_id`. The existing requirements pipeline is untouched.

```
lib/agent/
├── types.ts                    — Job, AgentPlan, FileChange, TestResult, LogEntry
├── executor.ts                 — IExecutor interface + LocalExecutor implementation
├── progress.ts                 — writes LogEntry rows to job_logs (Supabase Realtime)
├── job-runner.ts               — orchestrates all 3 loops, manages job state machine
└── agents/
    ├── requirements.agent.ts   — self-critiquing requirements extractor
    ├── planner.agent.ts        — file-tree-aware task planner
    └── coder.agent.ts          — diff-producing code generator

lib/agent/prompts/
├── requirements-loop-prompt.ts
├── planner-prompt.ts
└── coder-prompt.ts
```

All agent calls go through the existing `lib/ai/` provider abstraction (`AIProvider`, `CompletionResult`). No new AI dependencies.

### Executor Interface

```typescript
interface IExecutor {
  getFileTree(projectPath: string): Promise<string[]>
  readFile(projectPath: string, filePath: string): Promise<string>
  readFiles(projectPath: string, filePaths: string[]): Promise<Record<string, string>>
  writeFiles(projectPath: string, changes: FileChange[]): Promise<void>
  runTests(projectPath: string): Promise<TestResult>
  detectTestCommand(projectPath: string): Promise<string>   // reads package.json scripts.test
  createBranch(projectPath: string, branchName: string): Promise<void>
  getGitDiff(projectPath: string): Promise<string>
}
```

`LocalExecutor` is the only implementation for MVP. Operates directly on the filesystem and runs git/test commands via `child_process.exec`. Target path is stored per-project.

---

## Database Schema

### Additions to existing tables

```sql
-- projects: store the target external project path
ALTER TABLE projects ADD COLUMN target_path TEXT;
ALTER TABLE projects ADD COLUMN test_command TEXT; -- optional override
```

### New tables

```sql
CREATE TABLE jobs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          UUID NOT NULL REFERENCES projects(id),
  requirement_set_id  UUID NOT NULL REFERENCES requirement_sets(id),
  status              TEXT NOT NULL DEFAULT 'pending',
  -- pending | requirements_loop | plan_loop | awaiting_plan_approval
  -- | coding | awaiting_review | done | failed | cancelled
  branch_name         TEXT,
  iteration_count     INTEGER NOT NULL DEFAULT 0,
  error               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ
);

CREATE TABLE agent_plans (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id              UUID NOT NULL REFERENCES jobs(id),
  tasks               JSONB NOT NULL,      -- PlanTask[]
  files_to_create     TEXT[] NOT NULL DEFAULT '{}',
  files_to_modify     TEXT[] NOT NULL DEFAULT '{}',
  test_approach       TEXT NOT NULL,
  branch_name         TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE job_logs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id              UUID NOT NULL REFERENCES jobs(id),
  phase               TEXT NOT NULL,       -- requirements | planning | coding | system
  level               TEXT NOT NULL,       -- info | warn | error | success
  message             TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Supabase Realtime enabled on job_logs for live execution screen
```

### Key types

```typescript
interface PlanTask {
  id: string
  title: string
  description: string
  files: string[]           // files this task touches
  dependencies: string[]    // task ids that must complete first
}

interface FileChange {
  path: string
  content: string
  operation: 'create' | 'modify' | 'delete'
}

interface TestResult {
  success: boolean
  passed: number
  failed: number
  errors: string[]
  raw_output: string
}
```

---

## Agent Loops

### Requirements Loop (max 3 iterations)

```
requirementsAgent.run(rawText):
  iteration 1: parse raw text → structured items + assumptions
               agent also outputs: critique[], confidence (0-100)
  if confidence < 80:
    iteration 2: re-parse with critique[] injected as additional context
  if confidence still < 80 after iteration 2:
    surface remaining critique items as gaps via existing gap screen
  output: requirement_set with items[]
```

The existing gap-resolution UI handles anything the loop couldn't auto-resolve. Requirements loop reduces the human Q&A burden — it doesn't eliminate it.

### Planning Loop (max 2 iterations)

```
plannerAgent.run(requirements, projectPath):
  step 1: get file tree → ask for specific files to read
  step 2: read requested files → produce final plan
  output: AgentPlan { tasks[], files_to_create[], files_to_modify[],
                      test_approach, branch_name_suggestion }
```

The planner also outputs the branch name in the form `sf/<requirement-set-id-short>-<slug>`.

### Coding Loop (max 10 iterations)

```typescript
while (!done && iteration < MAX_CODING_ITERATIONS) {
  progress.log(jobId, `Coding iteration ${iteration + 1}...`, 'info')

  const changes = await coderAgent.run({
    requirements,
    plan,
    previousErrors,
    currentFileContents   // executor reads files_to_modify before each iteration
  })

  await executor.writeFiles(target_path, changes)
  progress.log(jobId, 'Running tests...', 'info')

  const result = await executor.runTests(target_path)

  if (result.success) {
    done = true
    await executor.createBranch(target_path, plan.branch_name)
    progress.log(jobId, `Branch created: ${plan.branch_name}`, 'success')
  } else {
    previousErrors = result.errors
    progress.log(jobId, `${result.failed} tests failed — feeding back`, 'warn')
  }

  iteration++
}

job.status = done ? 'awaiting_review' : 'failed'
```

The coder prompt explicitly instructs: *"for every file you create or modify, write or update the corresponding test file."*

---

## API Routes

```
POST   /api/jobs                — create + start job (async, returns job immediately)
GET    /api/jobs/[id]           — job + plan + logs + latest test result
PATCH  /api/jobs/[id]           — body: { action: 'approve_plan' | 'approve_review' | 'retry' | 'cancel' }
DELETE /api/jobs/[id]           — cancel and clean up
```

`POST /api/jobs` kicks off `job-runner.ts` asynchronously (does not await completion). The job_id is returned immediately so the UI can navigate to the execution screen.

---

## UI Screens

### Plan Screen — `/projects/[id]/jobs/[jobId]/plan`

Shown when `job.status = awaiting_plan_approval`.

- Task list: each task shows title, description, files it touches
- Files panel: two columns — files to create (green) / files to modify (yellow)
- Test approach description from planner
- "Approve Plan" button → PATCH job { action: 'approve_plan' }
- "Cancel" button

### Execution Screen — `/projects/[id]/jobs/[jobId]/execution`

Shown while `job.status = coding`. The "wow" screen.

- **Iteration counter:** `Iteration 3 / 10`
- **Live log feed:** subscribes to `job_logs` via Supabase Realtime. Each row rendered as it arrives. Color-coded by level (info=white, warn=yellow, error=red, success=green).
- **Phase indicator:** Requirements → Planning → Coding (active) → Review
- **Spinner / checkmark / X** per phase
- Auto-navigates to Review Screen when status becomes `awaiting_review`
- Auto-shows failure state when status becomes `failed`

### Review Screen — `/projects/[id]/jobs/[jobId]/review`

Shown when `job.status = awaiting_review`.

- **Git diff viewer:** syntax-highlighted, file-by-file, additions/deletions
- **Test results:** passed count, failed count, any warnings
- **Approve** → PATCH job { action: 'approve_review' } → status = done
- **Retry** → PATCH job { action: 'retry' } → status = coding, loop runs again

### Component structure

```
components/agent/
├── plan-screen.tsx
├── execution-screen.tsx     — uses Supabase Realtime subscription
└── review-screen.tsx        — git diff viewer component

app/projects/[id]/jobs/[jobId]/
├── plan/page.tsx
├── execution/page.tsx
└── review/page.tsx
```

---

## Error Handling

| Scenario | Behavior |
|---|---|
| Requirements loop hits max iterations | Surface remaining gaps to human via existing gap screen |
| Planning loop hits max iterations | Job fails with explanation message, user can retry |
| Coding loop hits max 10 iterations | Job status = failed, last errors shown on execution screen |
| executor: path doesn't exist | Immediate fail with clear message |
| executor: no test command found | Immediate fail: "No test script found in package.json" |
| executor: git not available | Immediate fail: "git not found in PATH" |
| AI provider error | Reuse existing retry/fallback from lib/ai/ adapters |
| User cancels mid-run | job-runner checks cancelled flag between iterations, exits cleanly |

---

## Testing Strategy

| Layer | Approach |
|---|---|
| `lib/agent/executor.ts` | Unit tests using `fs.mkdtempSync` — real temp dir, write/read/run trivial test suite |
| `lib/agent/job-runner.ts` | Integration tests using `MockAIProvider` (existing) + mock executor |
| `lib/agent/agents/*.ts` | Unit tests: given input X, assert prompt contains required context |
| API routes | Vitest, mock job-runner, assert state transitions |
| UI screens | Not tested in MVP — covered by manual review |

---

## What This Doesn't Cover (Out of Scope for MVP)

- E2B / Docker sandbox (LocalExecutor only for now)
- Automatic PR creation (user opens PR from the branch manually)
- Multi-file conflict resolution (coder overwrites, no merge logic)
- Parallel task execution (tasks run sequentially per plan order)
- Cost tracking per job (tokens logged to existing ai_usage_log but no per-job summary UI)
