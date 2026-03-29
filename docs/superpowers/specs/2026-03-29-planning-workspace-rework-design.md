# Planning Workspace Rework — Design Spec

**Goal:** Replace the black-box loading spinner and static plan review screen with a live, interactive planning workspace.

**Scope:** Everything from the moment the user clicks "Generate Plan & Spec" to the moment execution starts.

---

## Overview

The current planning phase has two problems: the loading screen gives zero feedback while the AI works (30–60s black box), and the plan review screen is read-only with unrendered markdown and no way to adjust the plan before committing to execution. This rework fixes both.

The new flow:
1. **Loading** — live activity feed while planning runs
2. **Plan workspace** — interactive task list + rendered spec, with inline editing and a safe confirm step before execution

---

## Architecture

### Files modified
- `components/agent/plan-loading.tsx` — add logs polling + sidebar feed
- `components/agent/plan-screen.tsx` — full rework: rendered spec, inline task editing, confirm step
- `app/api/jobs/[id]/route.ts` — add `update_tasks` PATCH action
- `components/agent/vision-screen.tsx` — extract `LogFeed` into shared component
- `components/agent/log-feed.tsx` — new shared component (extracted from VisionScreen)

### Dependencies
- `react-markdown` — install for spec rendering

---

## Section 1: Loading Phase

**Component:** `PlanLoading`

The GET `/api/jobs/[id]` already returns `{ job, plan, logs }`. The component polls every 2s and now stores and displays logs alongside job status.

**Layout:**
- **Main area**: Centered progress indicator + phase label that updates from the latest log entry
  - Phase sequence: "Reading project structure..." → "Analyzing requirements..." → "Generating tasks..." → "Writing spec..."
- **Sidebar** (JobShell): `LogFeed` component showing live log entries with timestamps, level colors, and icons — identical to the Vision step sidebar

**State:**
- `logs: LogEntry[]` — updated on each poll from `response.logs`
- `error: string | null` — shown inline on failure, polling stops
- `initialError?: string` — pre-populated when server renders a failed job (already in place)

**Transitions:**
- `awaiting_plan_approval` → `router.refresh()` re-renders server component showing `PlanScreen`
- `failed` → stop polling, show error + "Back to Requirements" button
- `cancelled` → redirect to requirements

---

## Section 2: Plan Workspace Layout

**Component:** `PlanScreen`

**Header row:**
- Left: branch name pill (`sf/xxx-yyy`) + files to create (green count) + files to modify (amber count)
- Right: Approve button (or confirmation strip when confirming)

**Sidebar** (JobShell):
- Task count
- Files to create / modify
- Test approach summary

**Tab bar:** Tasks | Spec — same tab pattern as requirements workspace

**Tasks tab:** Interactive task list (Section 3)

**Spec tab:** `react-markdown` rendered spec — properly styled headings, paragraphs, lists, code blocks. Falls back to empty state if `spec_markdown` is null.

---

## Section 3: Task Inline Editing

Each task has three modes:

**View mode:**
- Task number, title, description, file chips
- On row hover: pencil icon (edit) + trash icon (delete) appear on the right

**Edit mode** (pencil clicked):
- Title → `<input>`
- Description → `<textarea>`
- Files → comma-separated `<input>` (parsed back to array on save)
- Check icon to save, X to cancel
- On save: `PATCH /api/jobs/[id]` with `{ action: 'update_tasks', tasks: PlanTask[] }` — full array replacement

**Add task** (bottom of list):
- "+ Add Task" button → inline form appears (same fields as edit mode)
- New task gets id `task-{n+1}` where n is current task count
- On save: same `update_tasks` PATCH

**Delete:**
- Immediate removal from local state + `update_tasks` PATCH
- No undo (keep it simple)

**API change — `PATCH /api/jobs/[id]`:**
New action `update_tasks`:
```typescript
if (action === 'update_tasks') {
  if (job.status !== 'awaiting_plan_approval') return 422
  await db.from('agent_plans')
    .update({ tasks: body.tasks })
    .eq('job_id', id)
  return { ok: true }
}
```

---

## Section 4: Approve Confirmation

**First click** on "Approve & Start Execution" → button transforms into a confirmation strip inline:

```
This will create branch `sf/xxx-yyy` and start coding — 8 tasks, 12 files.   [Cancel]  [Confirm & Start →]
```

- Driven by `confirming: boolean` state — no extra API call
- "Cancel" sets `confirming` back to false
- "Confirm & Start" triggers existing approve logic → redirects to execution
- Branch name, task count, file count all read from `plan` prop

---

## Error Handling

- Task save failure: show inline error below the task form, revert local state
- Approve failure: existing `approveError` state (already in place)
- Loading failure: shown inline with error message from `job.error`

---

## Out of Scope

- Regenerate plan with AI feedback (removed — inline editing covers the use case)
- Task dependency visualisation
- Effort/complexity estimates per task
