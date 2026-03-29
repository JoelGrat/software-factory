# Multi-Phase Planner — Design Spec

**Goal:** Replace the single monolithic plan-generation AI call with a four-phase pipeline that eliminates JSON truncation, produces higher-quality output, and streams tasks live to the UI as each component is processed.

**Scope:** Backend planner pipeline (`lib/agent/agents/planner.agent.ts`, `lib/agent/prompts/planner-prompt.ts`, `lib/agent/job-runner.ts`) and the `PlanLoading` frontend component. No DB schema changes. `PlanScreen` and the coder pipeline are untouched.

---

## Overview

The current planner makes one large JSON call that generates the entire plan at once. This causes JSON truncation when requirements are large, produces lower-quality output (AI is doing too much at once), and gives the user a blank screen for 1-3 minutes.

The new pipeline makes four focused AI calls in sequence. Each call is small and bounded. Tasks are written to the DB incrementally after each component, so the frontend can show them appearing live. The final spec call has a generous token budget and the full picture to work from.

---

## Architecture

### New phase functions (pure, independently testable)

**`lib/agent/agents/planner.agent.ts`** is refactored to export four phase functions plus a coordinator:

```
runArchitecturePhase(requirements, fileTree, fileContents, ai) → Architecture
runComponentTasksPhase(architecture, component, requirements, fileContents, ai) → PlanTask[]
runDependencyResolutionPhase(allTasks, ai) → PlanTask[]
runSpecPhase(architecture, requirements, plan, ai) → string
runPlannerAgent(requirements, projectPath, executor, ai, db, jobId) → AgentPlan
```

`runPlannerAgent` orchestrates all four phases with DB writes between them. `job-runner.ts` calls it the same way as before — the interface change is adding `db` and `jobId` parameters so the agent can write incrementally.

### New `Architecture` type (in-memory only, not persisted)

```typescript
interface PlannerComponent {
  name: string
  description: string
  requirement_indices: number[]   // indices into the requirements array
  key_files: string[]             // files this component will touch
}

interface Architecture {
  components: PlannerComponent[]
  tech_decisions: string[]
  test_approach: string
  branch_name: string
}
```

Not stored in DB — lives in memory for the duration of the planning job.

### New frontend component

**`components/agent/plan-task-preview.tsx`** — read-only task list used by `PlanLoading`. Separate from `TaskList` in `plan-screen.tsx`.

---

## Phase 1: Architecture

**AI call:** One JSON call with `responseSchema`.

**Input:** All requirements (formatted as `[TYPE] [priority] title: description`) + file tree (up to 200 entries) + file contents (if imported project).

**Output schema:**
```typescript
{
  components: Array<{
    name: string
    description: string
    requirement_indices: number[]
    key_files: string[]
  }>
  tech_decisions: string[]
  test_approach: string
  branch_name: string   // format: "sf/<6-char-id>-<slug>"
}
```

**Token budget:** `maxTokens: 2048`, `timeout: 60_000`. Small structured output.

**DB write after this phase:**
```typescript
await db.from('agent_plans').insert({
  job_id: jobId,
  tasks: [],
  files_to_create: [],
  files_to_modify: [],
  test_approach: architecture.test_approach,
  branch_name: architecture.branch_name,
  spec_markdown: null,
})
```

**Log entries:**
```
"Analyzing requirements and designing architecture..."   [info]
"Architecture ready — {N} components identified"        [success]
```

---

## Phase 2: Tasks per Component

**AI call:** One JSON call per component, sequential.

**Input per call:** Full architecture JSON (as context) + this component's requirements (subset) + relevant file contents (component's `key_files`).

**Output schema per call:**
```typescript
{
  tasks: Array<{
    title: string
    description: string
    files: string[]
    intra_dependencies: string[]   // titles of tasks within this component only
  }>
}
```

No IDs at this stage — assigned during merge. No cross-component dependencies — resolved in Phase 3.

**Token budget:** `maxTokens: 4096`, `timeout: 60_000` per component call.

**DB write after each component:**
Assign sequential IDs to the new tasks (`task-{n+1}`, `task-{n+2}`, ...). Append to accumulated task list. Update DB:
```typescript
await db.from('agent_plans')
  .update({ tasks: accumulatedTasks, files_to_create: [...], files_to_modify: [...] })
  .eq('job_id', jobId)
```

`files_to_create` and `files_to_modify` are recomputed from all accumulated task files after each component (deduped).

**Log entries per component:**
```
"Generating tasks for {Component Name} ({N} requirements)..."   [info]
"{Component Name} — {N} tasks generated"                        [success]
```

---

## Phase 3: Dependency Resolution

**AI call:** One small JSON call with the full merged task list.

**Input:** Array of `{ id, title, component }` for all tasks — minimal context, just enough to reason about ordering.

**Output schema:**
```typescript
{
  dependencies: Array<{
    task_id: string        // e.g. "task-5"
    depends_on: string[]   // e.g. ["task-1", "task-3"]
  }>
}
```

Applied to the merged task list: for each entry, set `task.dependencies = depends_on`. Intra-component dependencies (resolved from titles in Phase 2) are also finalized here by merging with cross-component deps.

**Token budget:** `maxTokens: 1024`, `timeout: 30_000`. Very small call.

**DB write after this phase:**
```typescript
await db.from('agent_plans')
  .update({ tasks: tasksWithDependencies })
  .eq('job_id', jobId)
```

**Log entries:**
```
"Resolving cross-component dependencies..."   [info]
```

---

## Phase 4: Spec Generation

**AI call:** One plain-text call (no `responseSchema`).

**Input:** Full architecture + all requirements + complete merged plan (tasks with dependencies). Written after the full picture is assembled.

**Output:** Plain markdown string.

**Token budget:** `maxTokens: 8192`, `timeout: 120_000`.

**DB write after this phase:**
```typescript
await db.from('agent_plans')
  .update({ spec_markdown: specMarkdown })
  .eq('job_id', jobId)
```

Best-effort: wrapped in try/catch. If spec generation fails, planning still completes with `spec_markdown: null`.

**Log entries:**
```
"Writing implementation specification..."                          [info]
"Plan ready — {N} tasks across {M} components"                    [success]
```

---

## Frontend: PlanLoading with Live Task Feed

### No API changes needed

`/api/jobs/[id]` GET already returns `{ job, plan, logs }`. The plan is now written early (after Phase 1) and updated incrementally. `PlanLoading` just needs to use the `plan` data it already receives.

### New component: `plan-task-preview.tsx`

```typescript
// components/agent/plan-task-preview.tsx
interface Props {
  tasks: PlanTask[]
}
```

Renders task number, title, description, and file chips. No edit/delete/add controls. Cards animate in with a CSS fade on mount (`animate-fadeIn` or equivalent). Identical visual style to `PlanScreen` task cards.

### `PlanLoading` changes

The main content area shows two zones once tasks start appearing:

- **Top zone** (always visible): pulsing indicator + current phase label from latest log
- **Bottom zone** (shown when `plan?.tasks.length > 0`): `PlanTaskPreview` with the live-growing task list

The sidebar (log feed) is unchanged.

```typescript
// Additional state in PlanLoading:
const [plan, setPlan] = useState<AgentPlan | null>(null)

// In poll():
const { job, logs: newLogs, plan: newPlan } = await res.json()
if (newPlan) setPlan(newPlan)
```

### Transition to PlanScreen

Unchanged. When `job.status === 'awaiting_plan_approval'`, `router.refresh()` re-renders the server component which shows the full editable `PlanScreen`. The tasks the user saw appearing are now editable.

---

## Error Handling

- **Phase 1 failure:** Job fails immediately — no plan was written. Error shown in `PlanLoading` as before.
- **Phase 2 component failure:** Job fails. Partial tasks already written to DB but job status stays `plan_loop` then transitions to `failed`. Error shown inline.
- **Phase 3 failure:** Tasks without cross-component deps are still valid. Wrap in try/catch — if resolution fails, keep tasks with only intra-component deps and log a warning.
- **Phase 4 failure:** Best-effort as before — plan completes with `spec_markdown: null`.

---

## Files Modified / Created

| Action | Path | Change |
|--------|------|--------|
| Modify | `lib/agent/agents/planner.agent.ts` | Full rewrite: four phase functions + coordinator |
| Modify | `lib/agent/prompts/planner-prompt.ts` | New prompt builders for each phase |
| Modify | `lib/agent/job-runner.ts` | Pass `db` + `jobId` to `runPlannerAgent` |
| Modify | `components/agent/plan-loading.tsx` | Use `plan` from poll, show `PlanTaskPreview` |
| Create | `components/agent/plan-task-preview.tsx` | Read-only animated task list |
| Create | `tests/lib/agent/agents/planner-phases.test.ts` | Unit tests for each phase function |

---

## Out of Scope

- Grouped task UI in `PlanScreen` (groups are a generation strategy only — output is flat)
- Resume-from-failure (if job crashes mid-phase, restart from Phase 1)
- Parallel component task generation (sequential keeps logs ordered and avoids write conflicts)
- DB schema changes
