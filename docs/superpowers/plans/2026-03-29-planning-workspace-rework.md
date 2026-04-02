# Planning Workspace Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the static loading spinner and read-only plan review screen with a live activity feed during generation and a fully interactive plan workspace with inline task editing, rendered spec, and a safe approve confirmation step.

**Architecture:** Extract `LogFeed` into a shared component reused by both `VisionScreen` and `PlanLoading`. `PlanLoading` polls the existing `/api/jobs/[id]` GET (which already returns logs) and displays them live. `PlanScreen` becomes a stateful workspace where tasks are editable and saved to DB via a new `update_tasks` PATCH action. Spec tab renders markdown with `react-markdown`. Approve button shows an inline confirmation strip before committing.

**Tech Stack:** Next.js 14 App Router, React 18, TypeScript, Tailwind CSS, `react-markdown@8`, `remark-gfm@3`, Supabase, Vitest

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `components/agent/log-feed.tsx` | Shared log feed component (extracted from VisionScreen) |
| Create | `components/ui/markdown-view.tsx` | Renders markdown string with styled components |
| Modify | `components/agent/vision-screen.tsx` | Import LogFeed from shared location |
| Modify | `components/agent/plan-loading.tsx` | Add logs polling + sidebar with LogFeed |
| Modify | `components/agent/plan-screen.tsx` | Full rework: task state, inline editing, rendered spec, confirm strip |
| Modify | `app/api/jobs/[id]/route.ts` | Add `update_tasks` PATCH action |
| Create | `tests/api/jobs/update-tasks.test.ts` | Unit test for update_tasks validation logic |
| Create | `lib/agent/update-tasks-validator.ts` | Pure validation function (testable) |

---

### Task 1: Extract LogFeed into shared component

**Files:**
- Create: `components/agent/log-feed.tsx`
- Test: `tests/lib/agent/log-feed-validator.test.ts` (not needed — pure UI, no logic to test)

- [ ] **Step 1: Create `components/agent/log-feed.tsx`**

```tsx
'use client'
import { useEffect, useRef } from 'react'
import type { LogLevel } from '@/lib/supabase/types'

const LOG_COLORS: Record<string, string> = {
  info: '#c7c4d7', warn: '#f59e0b', error: '#ffb4ab', success: '#22c55e',
}
const LOG_ICONS: Record<string, string> = {
  info: 'info', warn: 'warning', error: 'error', success: 'check_circle',
}

export interface FeedEntry {
  id: string
  level: LogLevel
  message: string
  created_at: string
}

interface Props {
  logs: FeedEntry[]
}

export function LogFeed({ logs }: Props) {
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [logs])
  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-1 font-mono text-[11px]">
      {logs.length === 0 && (
        <div className="flex items-center gap-2 text-slate-500">
          <span className="material-symbols-outlined animate-pulse" style={{ fontSize: '14px' }}>hourglass_empty</span>
          <span>Waiting...</span>
        </div>
      )}
      {logs.map(log => (
        <div key={log.id} className="flex items-start gap-2 py-0.5">
          <span
            className="material-symbols-outlined mt-0.5 flex-shrink-0"
            style={{ fontSize: '12px', color: LOG_COLORS[log.level] ?? '#c7c4d7' }}
          >
            {LOG_ICONS[log.level] ?? 'circle'}
          </span>
          <div className="flex-1 min-w-0">
            <span className="text-slate-600 mr-2">{new Date(log.created_at).toLocaleTimeString()}</span>
            <span style={{ color: LOG_COLORS[log.level] ?? '#c7c4d7' }}>{log.message}</span>
          </div>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add components/agent/log-feed.tsx
git commit -m "feat: extract LogFeed into shared component"
```

---

### Task 2: Update VisionScreen to use shared LogFeed

**Files:**
- Modify: `components/agent/vision-screen.tsx`

The current file defines `LOG_COLORS`, `LOG_ICONS`, and `LogFeed` inline at the top (lines 11–44). Replace them with an import.

- [ ] **Step 1: Remove inline definitions and import from shared component**

In `components/agent/vision-screen.tsx`, replace the top of the file:

```tsx
// Remove these lines (lines 11–44):
const LOG_COLORS: Record<string, string> = {
  info: '#c7c4d7', warn: '#f59e0b', error: '#ffb4ab', success: '#22c55e',
}
const LOG_ICONS: Record<string, string> = {
  info: 'info', warn: 'warning', error: 'error', success: 'check_circle',
}

function LogFeed({ logs }: { logs: VisionLog[] }) {
  ...
}
```

Add import at top of file (after existing imports):

```tsx
import { LogFeed } from '@/components/agent/log-feed'
import type { FeedEntry } from '@/components/agent/log-feed'
```

- [ ] **Step 2: Cast VisionLog to FeedEntry where LogFeed is used**

`VisionLog` has `id, level, message, created_at` — compatible with `FeedEntry`. In the sidebar JSX (currently `<LogFeed logs={logs} />`), cast:

```tsx
<LogFeed logs={logs as FeedEntry[]} />
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add components/agent/vision-screen.tsx
git commit -m "refactor: use shared LogFeed in VisionScreen"
```

---

### Task 3: Add live logs to PlanLoading

**Files:**
- Modify: `components/agent/plan-loading.tsx`

The GET `/api/jobs/[id]` returns `{ job, plan, logs }`. Currently `PlanLoading` only reads `job`. This task makes it also read `logs` and show them in a live sidebar feed.

- [ ] **Step 1: Update `components/agent/plan-loading.tsx`**

Replace the entire file with:

```tsx
'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { JobShell } from '@/components/agent/job-shell'
import { StepIndicator } from '@/components/agent/step-indicator'
import { LogFeed } from '@/components/agent/log-feed'
import type { FeedEntry } from '@/components/agent/log-feed'

interface Props {
  jobId: string
  projectId: string
  projectName: string
  initialError?: string
}

export function PlanLoading({ jobId, projectId, projectName, initialError }: Props) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(initialError ?? null)
  const [logs, setLogs] = useState<FeedEntry[]>([])

  useEffect(() => {
    if (initialError) return

    const poll = async () => {
      const res = await fetch(`/api/jobs/${jobId}`)
      if (!res.ok) return
      const { job, logs: newLogs } = await res.json()
      if (newLogs) setLogs(newLogs as FeedEntry[])
      if (job.status === 'awaiting_plan_approval') {
        router.refresh()
      } else if (job.status === 'failed') {
        setError(job.error ?? 'Planning failed — unknown error')
      } else if (job.status === 'cancelled') {
        router.push(`/projects/${projectId}/requirements`)
      }
    }

    const id = setInterval(poll, 2000)
    return () => clearInterval(id)
  }, [jobId, projectId, router, initialError])

  const latestMessage = logs.length > 0
    ? logs[logs.length - 1].message
    : 'Analyzing requirements...'

  const sidebar = (
    <div className="flex flex-col h-full">
      <LogFeed logs={logs} />
    </div>
  )

  return (
    <JobShell
      projectName={projectName}
      projectId={projectId}
      jobId={jobId}
      sidebar={sidebar}
      sidebarTitle={`Activity Log (${logs.length})`}
    >
      <div className="max-w-4xl mx-auto space-y-8">
        <StepIndicator current={3} />
        {error ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <span className="material-symbols-outlined text-error mb-4" style={{ fontSize: '40px' }}>error</span>
            <h2 className="text-xl font-extrabold font-headline text-white mb-2">Planning Failed</h2>
            <p className="text-slate-400 text-sm max-w-md font-mono bg-surface-container px-4 py-3 rounded-lg border border-error/20 mt-2">{error}</p>
            <button
              onClick={() => router.push(`/projects/${projectId}/requirements`)}
              className="mt-6 px-4 py-2 rounded-lg text-sm text-slate-400 hover:text-slate-200 border border-white/10 hover:border-white/20 transition-all"
            >
              Back to Requirements
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <span className="relative flex h-5 w-5 mb-6">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-5 w-5 bg-indigo-400" />
            </span>
            <h2 className="text-2xl font-extrabold font-headline text-white mb-2">Generating Plan</h2>
            <p className="text-slate-400 text-sm">{latestMessage}</p>
            <p className="text-slate-600 text-xs mt-2 font-mono">This takes about 30–60 seconds</p>
          </div>
        )}
      </div>
    </JobShell>
  )
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/agent/plan-loading.tsx
git commit -m "feat: show live activity log in planning loading screen"
```

---

### Task 4: Install react-markdown and create MarkdownView component

**Files:**
- Create: `components/ui/markdown-view.tsx`

- [ ] **Step 1: Install react-markdown v8 and remark-gfm v3**

```bash
npm install react-markdown@8 remark-gfm@3
```

Expected: both packages appear in `package.json` dependencies.

- [ ] **Step 2: Create `components/ui/markdown-view.tsx`**

```tsx
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface Props {
  children: string
  className?: string
}

export function MarkdownView({ children, className = '' }: Props) {
  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children: c }) => <h1 className="text-lg font-bold text-white mb-3 mt-6 first:mt-0 font-headline">{c}</h1>,
          h2: ({ children: c }) => <h2 className="text-base font-bold text-slate-200 mb-2 mt-5 font-headline">{c}</h2>,
          h3: ({ children: c }) => <h3 className="text-sm font-semibold text-slate-300 mb-2 mt-4 font-headline">{c}</h3>,
          p: ({ children: c }) => <p className="text-sm text-slate-400 leading-relaxed mb-3">{c}</p>,
          ul: ({ children: c }) => <ul className="list-disc list-inside space-y-1 mb-3">{c}</ul>,
          ol: ({ children: c }) => <ol className="list-decimal list-inside space-y-1 mb-3">{c}</ol>,
          li: ({ children: c }) => <li className="text-sm text-slate-400">{c}</li>,
          code: ({ children: c }) => <code className="text-xs font-mono bg-surface-container-high px-1.5 py-0.5 rounded text-indigo-300">{c}</code>,
          pre: ({ children: c }) => <pre className="bg-surface-container rounded-lg p-4 overflow-x-auto mb-3 text-xs font-mono text-slate-300 border border-white/5">{c}</pre>,
          strong: ({ children: c }) => <strong className="font-semibold text-slate-200">{c}</strong>,
          hr: () => <hr className="border-white/10 my-4" />,
          a: ({ children: c, href }) => <a href={href} className="text-indigo-400 hover:underline" target="_blank" rel="noreferrer">{c}</a>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add components/ui/markdown-view.tsx package.json package-lock.json
git commit -m "feat: add MarkdownView component with react-markdown"
```

---

### Task 5: Add update_tasks validation + API action

**Files:**
- Create: `lib/agent/update-tasks-validator.ts`
- Modify: `app/api/jobs/[id]/route.ts`
- Create: `tests/lib/agent/update-tasks-validator.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/agent/update-tasks-validator.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { validateUpdateTasks } from '@/lib/agent/update-tasks-validator'

describe('validateUpdateTasks', () => {
  it('accepts a valid tasks array', () => {
    const tasks = [
      { id: 'task-1', title: 'Do X', description: 'desc', files: ['a.ts'], dependencies: [] },
    ]
    expect(validateUpdateTasks(tasks)).toEqual({ valid: true })
  })

  it('rejects non-array', () => {
    expect(validateUpdateTasks('not an array')).toEqual({ valid: false, error: 'tasks must be an array' })
  })

  it('rejects task missing title', () => {
    const tasks = [{ id: 'task-1', description: 'desc', files: [], dependencies: [] }]
    expect(validateUpdateTasks(tasks)).toEqual({ valid: false, error: expect.stringContaining('title') })
  })

  it('rejects task missing id', () => {
    const tasks = [{ title: 'T', description: 'desc', files: [], dependencies: [] }]
    expect(validateUpdateTasks(tasks)).toEqual({ valid: false, error: expect.stringContaining('id') })
  })

  it('accepts empty array', () => {
    expect(validateUpdateTasks([])).toEqual({ valid: true })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/lib/agent/update-tasks-validator.test.ts
```

Expected: FAIL — `Cannot find module '@/lib/agent/update-tasks-validator'`

- [ ] **Step 3: Create `lib/agent/update-tasks-validator.ts`**

```ts
import type { PlanTask } from '@/lib/supabase/types'

export function validateUpdateTasks(tasks: unknown): { valid: true } | { valid: false; error: string } {
  if (!Array.isArray(tasks)) return { valid: false, error: 'tasks must be an array' }
  for (const task of tasks) {
    if (typeof task !== 'object' || task === null) return { valid: false, error: 'each task must be an object' }
    const t = task as Record<string, unknown>
    if (typeof t.id !== 'string' || !t.id) return { valid: false, error: 'each task must have a string id' }
    if (typeof t.title !== 'string' || !t.title) return { valid: false, error: 'each task must have a string title' }
    if (typeof t.description !== 'string') return { valid: false, error: 'each task must have a string description' }
    if (!Array.isArray(t.files)) return { valid: false, error: 'each task must have a files array' }
    if (!Array.isArray(t.dependencies)) return { valid: false, error: 'each task must have a dependencies array' }
  }
  return { valid: true }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/lib/agent/update-tasks-validator.test.ts
```

Expected: PASS — 5 tests passing.

- [ ] **Step 5: Add `update_tasks` action to `app/api/jobs/[id]/route.ts`**

Inside the `PATCH` handler, add after the `cancel` action block (before the final `return`):

```ts
if (action === 'update_tasks') {
  if (job.status !== 'awaiting_plan_approval') {
    return NextResponse.json({ error: 'Job is not awaiting plan approval' }, { status: 422 })
  }
  const validation = validateUpdateTasks(body.tasks)
  if (!validation.valid) {
    return NextResponse.json({ error: validation.error }, { status: 400 })
  }
  await db.from('agent_plans').update({ tasks: body.tasks }).eq('job_id', id)
  return NextResponse.json({ ok: true })
}
```

Add import at top of the file:

```ts
import { validateUpdateTasks } from '@/lib/agent/update-tasks-validator'
```

- [ ] **Step 6: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Run all tests**

```bash
npx vitest run
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add lib/agent/update-tasks-validator.ts tests/lib/agent/update-tasks-validator.test.ts app/api/jobs/[id]/route.ts
git commit -m "feat: add update_tasks API action with validation"
```

---

### Task 6: Rework PlanScreen — layout, task state, spec tab

**Files:**
- Modify: `components/agent/plan-screen.tsx`

This task replaces the entire `PlanScreen` component. It adds: task state (initialized from `plan.tasks`), a proper header row, the `MarkdownView` spec tab, and wires the tasks list to use local state. Task editing is added in Task 7.

- [ ] **Step 1: Replace `components/agent/plan-screen.tsx`**

```tsx
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import type { AgentPlan, PlanTask } from '@/lib/supabase/types'
import { JobShell } from '@/components/agent/job-shell'
import { StepIndicator } from '@/components/agent/step-indicator'
import { MarkdownView } from '@/components/ui/markdown-view'

type Tab = 'tasks' | 'spec'

interface Props {
  jobId: string
  projectId: string
  projectName: string
  plan: AgentPlan
}

export function PlanScreen({ jobId, projectId, projectName, plan }: Props) {
  const router = useRouter()
  const [tasks, setTasks] = useState<PlanTask[]>(plan.tasks as PlanTask[])
  const [activeTab, setActiveTab] = useState<Tab>('tasks')
  const [savingTasks, setSavingTasks] = useState(false)
  const [taskError, setTaskError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [approving, setApproving] = useState(false)
  const [approveError, setApproveError] = useState<string | null>(null)

  async function updateTasks(updated: PlanTask[]) {
    setSavingTasks(true)
    setTaskError(null)
    const res = await fetch(`/api/jobs/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'update_tasks', tasks: updated }),
    })
    setSavingTasks(false)
    if (!res.ok) {
      const d = await res.json()
      setTaskError(d.error ?? 'Failed to save tasks')
      return false
    }
    setTasks(updated)
    return true
  }

  async function approvePlan() {
    setApproving(true)
    setApproveError(null)
    try {
      const res = await fetch(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve_plan' }),
      })
      if (!res.ok) { setApproveError('Failed to approve plan. Please try again.'); return }
      router.push(`/projects/${projectId}/jobs/${jobId}/execution`)
    } catch {
      setApproveError('Failed to approve plan. Please try again.')
    } finally {
      setApproving(false)
    }
  }

  async function cancel() {
    try {
      await fetch(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel' }),
      })
    } catch { /* best-effort */ }
    router.push(`/projects/${projectId}/requirements`)
  }

  const totalFiles = plan.files_to_create.length + plan.files_to_modify.length

  const sidebar = (
    <div className="p-5 space-y-4">
      <div className="p-3 bg-surface-container rounded-lg border border-white/5">
        <div className="text-[10px] text-slate-500 uppercase font-bold font-headline mb-1">Branch</div>
        <code className="text-xs font-mono text-indigo-300 break-all">{plan.branch_name || 'not yet created'}</code>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="p-3 bg-surface-container rounded-lg border border-white/5 text-center">
          <div className="text-[10px] text-slate-500 uppercase font-bold font-headline mb-1">Create</div>
          <div className="text-xl font-bold font-headline text-[#22c55e]">{plan.files_to_create.length}</div>
        </div>
        <div className="p-3 bg-surface-container rounded-lg border border-white/5 text-center">
          <div className="text-[10px] text-slate-500 uppercase font-bold font-headline mb-1">Modify</div>
          <div className="text-xl font-bold font-headline text-[#f59e0b]">{plan.files_to_modify.length}</div>
        </div>
      </div>
      <div className="p-3 bg-surface-container rounded-lg border border-white/5">
        <div className="text-[10px] text-slate-500 uppercase font-bold font-headline mb-1">Tasks</div>
        <div className="text-xl font-bold font-headline text-indigo-100">{tasks.length}</div>
      </div>
      {plan.test_approach && (
        <div className="p-3 bg-surface-container rounded-lg border border-white/5">
          <div className="text-[10px] text-slate-500 uppercase font-bold font-headline mb-2">Test Approach</div>
          <p className="text-xs text-slate-400 leading-relaxed">{plan.test_approach}</p>
        </div>
      )}
    </div>
  )

  return (
    <JobShell projectName={projectName} projectId={projectId} jobId={jobId} sidebar={sidebar} sidebarTitle="Plan Summary">
      <div className="max-w-4xl mx-auto space-y-6">
        <StepIndicator current={3} />

        {/* Header */}
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 flex-wrap">
            <code className="text-xs font-mono text-indigo-300 bg-indigo-500/10 border border-indigo-500/20 px-2 py-1 rounded-lg">
              {plan.branch_name || 'branch pending'}
            </code>
            <span className="text-xs text-[#22c55e] font-mono">+{plan.files_to_create.length} create</span>
            <span className="text-xs text-[#f59e0b] font-mono">~{plan.files_to_modify.length} modify</span>
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            <button
              onClick={cancel}
              className="text-xs font-bold text-slate-500 hover:text-white transition-colors uppercase tracking-widest px-4 py-2"
            >
              Cancel
            </button>
            {confirming ? (
              <div className="flex items-center gap-3 px-4 py-2.5 rounded-lg bg-surface-container border border-white/10">
                <p className="text-xs text-slate-400">
                  Create <code className="text-indigo-300 font-mono">{plan.branch_name}</code> and start coding —{' '}
                  <span className="text-white font-semibold">{tasks.length} tasks</span>,{' '}
                  <span className="text-white font-semibold">{totalFiles} files</span>.
                </p>
                <button
                  onClick={() => setConfirming(false)}
                  className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={approvePlan}
                  disabled={approving}
                  className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-headline font-bold bg-gradient-to-br from-primary to-primary-container text-on-primary-container disabled:opacity-50 hover:scale-[1.02] active:scale-95 transition-all"
                >
                  {approving ? 'Starting...' : 'Confirm & Start →'}
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirming(true)}
                className="bg-gradient-to-br from-primary to-primary-container text-on-primary-container px-6 py-2.5 rounded-lg font-headline font-extrabold text-sm flex items-center gap-2 shadow-[0_4px_20px_rgba(189,194,255,0.2)] hover:scale-[1.02] transition-transform active:scale-95"
              >
                Approve & Start Execution
                <span className="material-symbols-outlined text-[16px]">arrow_forward</span>
              </button>
            )}
          </div>
        </div>

        {approveError && <p className="text-xs text-error font-mono">{approveError}</p>}

        {/* Tab bar */}
        <div className="flex gap-1 p-1 rounded-lg" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)', display: 'inline-flex' }}>
          {([
            { id: 'tasks' as Tab, label: `Tasks (${tasks.length})` },
            { id: 'spec' as Tab, label: 'Spec File' },
          ]).map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className="px-4 py-2 rounded-md text-sm transition-all"
              style={{
                background: activeTab === tab.id ? 'var(--bg-elevated)' : 'transparent',
                color: activeTab === tab.id ? 'var(--text-primary)' : 'var(--text-muted)',
                fontFamily: 'var(--font-syne)',
                fontWeight: activeTab === tab.id ? '600' : '400',
                border: activeTab === tab.id ? '1px solid var(--border-default)' : '1px solid transparent',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tasks tab */}
        {activeTab === 'tasks' && (
          <TaskList
            tasks={tasks}
            saving={savingTasks}
            error={taskError}
            onUpdate={updateTasks}
          />
        )}

        {/* Spec tab */}
        {activeTab === 'spec' && (
          <div className="bg-surface-container rounded-xl border border-white/5 overflow-hidden">
            {plan.spec_markdown ? (
              <MarkdownView className="p-6">{plan.spec_markdown}</MarkdownView>
            ) : (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <span className="material-symbols-outlined text-slate-600 mb-3" style={{ fontSize: '32px' }}>description</span>
                <p className="text-slate-500 text-sm">No spec file was generated for this plan.</p>
              </div>
            )}
          </div>
        )}
      </div>
    </JobShell>
  )
}

// ── TaskList placeholder — replaced in Task 7 ────────────────────────────────

interface TaskListProps {
  tasks: PlanTask[]
  saving: boolean
  error: string | null
  onUpdate: (tasks: PlanTask[]) => Promise<boolean>
}

function TaskList({ tasks, saving, error }: TaskListProps) {
  return (
    <div className="space-y-3">
      {error && <p className="text-xs text-error font-mono">{error}</p>}
      {saving && <p className="text-xs text-slate-500 font-mono">Saving...</p>}
      {tasks.map((task, i) => (
        <div key={task.id} className="bg-surface-container rounded-xl p-4 border border-white/5">
          <div className="flex gap-3 items-start">
            <span className="text-xs font-mono text-indigo-400 min-w-[20px] mt-0.5">{i + 1}</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-on-surface mb-1">{task.title}</p>
              <p className="text-xs text-slate-400 mb-2">{task.description}</p>
              <div className="flex gap-1.5 flex-wrap">
                {task.files.map(f => (
                  <span key={f} className="text-[10px] text-slate-500 font-mono bg-surface-container-high px-1.5 py-0.5 rounded">{f}</span>
                ))}
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/agent/plan-screen.tsx
git commit -m "feat: rework PlanScreen layout with tabs, rendered spec, confirm strip"
```

---

### Task 7: Add inline task editing to TaskList

**Files:**
- Modify: `components/agent/plan-screen.tsx` (replace `TaskList` placeholder)

- [ ] **Step 1: Replace the `TaskList` function in `components/agent/plan-screen.tsx`**

Remove the `// ── TaskList placeholder` comment and the entire `TaskList` function, replace with:

```tsx
// ── TaskList ──────────────────────────────────────────────────────────────────

interface TaskListProps {
  tasks: PlanTask[]
  saving: boolean
  error: string | null
  onUpdate: (tasks: PlanTask[]) => Promise<boolean>
}

interface EditForm {
  title: string
  description: string
  files: string
}

const EMPTY_FORM: EditForm = { title: '', description: '', files: '' }

function TaskList({ tasks, saving, error, onUpdate }: TaskListProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<EditForm>(EMPTY_FORM)
  const [adding, setAdding] = useState(false)
  const [newForm, setNewForm] = useState<EditForm>(EMPTY_FORM)

  function startEdit(task: PlanTask) {
    setEditingId(task.id)
    setEditForm({ title: task.title, description: task.description, files: task.files.join(', ') })
  }

  async function saveEdit() {
    const updated = tasks.map(t =>
      t.id === editingId
        ? { ...t, title: editForm.title.trim(), description: editForm.description.trim(), files: editForm.files.split(',').map(f => f.trim()).filter(Boolean) }
        : t
    )
    const ok = await onUpdate(updated)
    if (ok) setEditingId(null)
  }

  async function deleteTask(id: string) {
    const updated = tasks.filter(t => t.id !== id)
    await onUpdate(updated)
  }

  async function saveNewTask() {
    if (!newForm.title.trim()) return
    const newTask: PlanTask = {
      id: `task-${tasks.length + 1}`,
      title: newForm.title.trim(),
      description: newForm.description.trim(),
      files: newForm.files.split(',').map(f => f.trim()).filter(Boolean),
      dependencies: [],
    }
    const ok = await onUpdate([...tasks, newTask])
    if (ok) { setAdding(false); setNewForm(EMPTY_FORM) }
  }

  const inputStyle = {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-default)',
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-jetbrains)',
    fontSize: '12px',
  }

  return (
    <div className="space-y-2">
      {error && <p className="text-xs text-error font-mono mb-2">{error}</p>}

      {tasks.map((task, i) => (
        <div key={task.id} className="group bg-surface-container rounded-xl border border-white/5 transition-all hover:border-white/10">
          {editingId === task.id ? (
            /* Edit mode */
            <div className="p-4 space-y-2">
              <input
                autoFocus
                value={editForm.title}
                onChange={e => setEditForm(p => ({ ...p, title: e.target.value }))}
                placeholder="Task title"
                className="w-full rounded-lg px-3 py-2 text-sm outline-none"
                style={inputStyle}
              />
              <textarea
                value={editForm.description}
                onChange={e => setEditForm(p => ({ ...p, description: e.target.value }))}
                placeholder="Description"
                rows={2}
                className="w-full rounded-lg px-3 py-2 text-sm resize-none outline-none"
                style={inputStyle}
              />
              <input
                value={editForm.files}
                onChange={e => setEditForm(p => ({ ...p, files: e.target.value }))}
                placeholder="Files (comma-separated)"
                className="w-full rounded-lg px-3 py-2 text-sm outline-none"
                style={inputStyle}
              />
              <div className="flex gap-2 justify-end">
                <button onClick={() => setEditingId(null)} className="px-3 py-1 rounded-lg text-xs text-slate-400 hover:text-slate-200 transition-colors">
                  Cancel
                </button>
                <button
                  onClick={saveEdit}
                  disabled={!editForm.title.trim() || saving}
                  className="flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 disabled:opacity-40 transition-all"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '13px' }}>check</span>
                  {saving ? 'Saving...' : 'Save'}
                </button>
              </div>
            </div>
          ) : (
            /* View mode */
            <div className="flex gap-3 items-start p-4">
              <span className="text-xs font-mono text-indigo-400 min-w-[20px] mt-0.5 flex-shrink-0">{i + 1}</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-on-surface mb-1">{task.title}</p>
                <p className="text-xs text-slate-400 mb-2">{task.description}</p>
                <div className="flex gap-1.5 flex-wrap">
                  {task.files.map(f => (
                    <span key={f} className="text-[10px] text-slate-500 font-mono bg-surface-container-high px-1.5 py-0.5 rounded">{f}</span>
                  ))}
                </div>
              </div>
              <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                <button
                  onClick={() => startEdit(task)}
                  className="p-1.5 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-white/5 transition-all"
                  title="Edit task"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>edit</span>
                </button>
                <button
                  onClick={() => deleteTask(task.id)}
                  disabled={saving}
                  className="p-1.5 rounded-lg text-slate-500 hover:text-error hover:bg-error/5 transition-all disabled:opacity-30"
                  title="Delete task"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>delete</span>
                </button>
              </div>
            </div>
          )}
        </div>
      ))}

      {/* Add task */}
      {adding ? (
        <div className="rounded-xl border border-indigo-500/20 bg-indigo-500/5 p-4 space-y-2">
          <input
            autoFocus
            value={newForm.title}
            onChange={e => setNewForm(p => ({ ...p, title: e.target.value }))}
            placeholder="Task title"
            className="w-full rounded-lg px-3 py-2 text-sm outline-none"
            style={inputStyle}
          />
          <textarea
            value={newForm.description}
            onChange={e => setNewForm(p => ({ ...p, description: e.target.value }))}
            placeholder="Description"
            rows={2}
            className="w-full rounded-lg px-3 py-2 text-sm resize-none outline-none"
            style={inputStyle}
          />
          <input
            value={newForm.files}
            onChange={e => setNewForm(p => ({ ...p, files: e.target.value }))}
            placeholder="Files (comma-separated)"
            className="w-full rounded-lg px-3 py-2 text-sm outline-none"
            style={inputStyle}
          />
          <div className="flex gap-2 justify-end">
            <button onClick={() => { setAdding(false); setNewForm(EMPTY_FORM) }} className="px-3 py-1 rounded-lg text-xs text-slate-400 hover:text-slate-200 transition-colors">
              Cancel
            </button>
            <button
              onClick={saveNewTask}
              disabled={!newForm.title.trim() || saving}
              className="flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-bold bg-gradient-to-br from-primary to-primary-container text-on-primary-container disabled:opacity-40 transition-all"
            >
              <span className="material-symbols-outlined" style={{ fontSize: '13px' }}>add</span>
              {saving ? 'Saving...' : 'Add Task'}
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-dashed border-white/10 text-xs text-slate-500 hover:text-slate-300 hover:border-white/20 transition-all font-headline font-bold uppercase tracking-wider"
        >
          <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>add</span>
          Add Task
        </button>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Run all tests**

```bash
npx vitest run
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add components/agent/plan-screen.tsx
git commit -m "feat: add inline task editing to plan workspace"
```

---

## Self-Review

**Spec coverage:**
- ✅ Section 1 (loading live logs) — Task 3
- ✅ Section 2 (plan workspace layout, rendered spec) — Tasks 4, 6
- ✅ Section 3 (inline task editing — view/edit/add/delete, save to DB) — Tasks 5, 7
- ✅ Section 4 (approve confirmation strip) — Task 6
- ✅ LogFeed extraction — Tasks 1, 2

**Placeholder scan:** All steps have concrete code. No TBDs.

**Type consistency:**
- `FeedEntry` defined in `log-feed.tsx`, imported in `plan-loading.tsx` and `vision-screen.tsx` ✅
- `PlanTask` from `@/lib/supabase/types` used throughout ✅
- `updateTasks` returns `Promise<boolean>`, `TaskList.onUpdate` prop typed accordingly ✅
- `TaskListProps` defined before `TaskList` usage ✅
