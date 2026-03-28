# Project Vision Step Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an async Vision step before Requirements for scratch projects — user describes the project, AI generates structured requirements in real time via Supabase Realtime.

**Architecture:** New `/projects/[id]/vision` screen uses `JobShell` (step 1 of 5). A fire-and-forget API route sets `project_visions.status = 'generating'`, calls the existing `getProvider()` AI abstraction, inserts `requirement_items` one by one, and writes `vision_logs` for the sidebar feed — all surfaced to the client via three Supabase Realtime subscriptions.

**Tech Stack:** Next.js 14 App Router, Supabase (Postgres + Realtime), `lib/ai` provider abstraction (`getProvider()`), Tailwind CSS / `JobShell` shell pattern.

---

## File Map

**New files:**
- `supabase/migrations/004_vision_schema.sql` — DB schema
- `lib/agent/vision-generator.ts` — background generation logic
- `lib/agent/prompts/vision.ts` — Claude prompt builder
- `app/api/projects/[id]/vision/route.ts` — GET + PATCH vision draft
- `app/api/projects/[id]/vision/generate/route.ts` — POST trigger
- `app/projects/[id]/vision/page.tsx` — server page
- `components/agent/vision-screen.tsx` — client component (all states)

**Modified files:**
- `lib/supabase/types.ts` — add `ProjectVision`, `VisionLog`, `VisionStatus` types
- `supabase/migrations/001_initial_schema.sql` — no change; new migration handles it
- `components/agent/step-indicator.tsx` — 5 steps, `skipVision` prop
- `components/projects/create-project-form.tsx` — redirect to `/vision`
- `app/api/projects/route.ts` — create `requirements` row at project creation, add `setup_mode`
- `app/projects/[id]/requirements/page.tsx` — step 2 (was 1)
- `components/agent/plan-screen.tsx` — step 3 (was 2)
- `components/agent/execution-screen.tsx` — step 4 (was 3)
- `components/agent/review-screen.tsx` — step 5 (was 4)

---

## Task 1: DB Migration

**Files:**
- Create: `supabase/migrations/004_vision_schema.sql`

- [ ] **Step 1: Write migration**

```sql
-- supabase/migrations/004_vision_schema.sql

-- Track project creation mode
alter table projects
  add column if not exists setup_mode text not null default 'scratch'
    check (setup_mode in ('scratch', 'imported'));

-- Vision content + generation status (one per project)
create table if not exists project_visions (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references projects(id) on delete cascade,
  mode            text not null default 'free_form'
                    check (mode in ('free_form', 'structured')),
  free_form_text  text not null default '',
  goal            text not null default '',
  tech_stack      text not null default '',
  target_users    text not null default '',
  key_features    text not null default '',
  constraints     text not null default '',
  status          text not null default 'draft'
                    check (status in ('draft', 'generating', 'done', 'failed')),
  error           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (project_id)
);

-- Append-only log feed (Realtime)
create table if not exists vision_logs (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  phase      text not null check (phase in ('parsing', 'generating', 'system')),
  level      text not null check (level in ('info', 'warn', 'error', 'success')),
  message    text not null,
  created_at timestamptz not null default now()
);

create index if not exists project_visions_project_id on project_visions(project_id);
create index if not exists vision_logs_project_id on vision_logs(project_id);
```

- [ ] **Step 2: Apply migration**

```bash
npx supabase db push
# or in Supabase Studio: run the SQL manually
```

Expected: no errors; `project_visions` and `vision_logs` tables exist.

- [ ] **Step 3: Enable Realtime on new tables**

In Supabase Studio → Database → Replication, enable Realtime for:
- `project_visions`
- `vision_logs`
- `requirement_items` (needed for live item feed — check if already enabled)

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/004_vision_schema.sql
git commit -m "feat: add vision schema migration"
```

---

## Task 2: Types

**Files:**
- Modify: `lib/supabase/types.ts`

- [ ] **Step 1: Add vision types after existing Job types**

Open `lib/supabase/types.ts` and append before the final export (or at the end of the file):

```typescript
// ── Vision ──────────────────────────────────────────────────────────────────

export type VisionMode   = 'free_form' | 'structured'
export type VisionStatus = 'draft' | 'generating' | 'done' | 'failed'

export interface ProjectVision {
  id:             string
  project_id:     string
  mode:           VisionMode
  free_form_text: string
  goal:           string
  tech_stack:     string
  target_users:   string
  key_features:   string
  constraints:    string
  status:         VisionStatus
  error:          string | null
  created_at:     string
  updated_at:     string
}

export type VisionLogPhase = 'parsing' | 'generating' | 'system'

export interface VisionLog {
  id:         string
  project_id: string
  phase:      VisionLogPhase
  level:      LogLevel        // reuse existing LogLevel type
  message:    string
  created_at: string
}
```

Also add `setup_mode` to the `Project` interface:

```typescript
export interface Project {
  id:         string
  name:       string
  owner_id:   string
  setup_mode: 'scratch' | 'imported'
  created_at: string
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add lib/supabase/types.ts
git commit -m "feat: add ProjectVision and VisionLog types"
```

---

## Task 3: Update Projects POST API

**Files:**
- Modify: `app/api/projects/route.ts`

The POST handler currently creates only a `projects` row and redirects to `/requirements`. After this task it also: sets `setup_mode = 'scratch'`, creates the initial `requirements` row, and returns the project id for client redirect to `/vision`.

- [ ] **Step 1: Update POST handler**

Replace the entire POST function in `app/api/projects/route.ts`:

```typescript
export async function POST(req: Request) {
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }

  const { data: project, error: projectError } = await db
    .from('projects')
    .insert({ name: body.name.trim(), owner_id: user.id, setup_mode: 'scratch' })
    .select('id, name, created_at, setup_mode')
    .single()

  if (projectError || !project) {
    return NextResponse.json({ error: 'Failed to create project' }, { status: 500 })
  }

  // Create requirements row eagerly so vision generator has a requirement_id
  const { data: req_ } = await db
    .from('requirements')
    .insert({ project_id: project.id, title: 'Requirements', raw_input: '', status: 'draft' })
    .select('id')
    .single()

  if (!req_) {
    return NextResponse.json({ error: 'Failed to initialise requirements' }, { status: 500 })
  }

  return NextResponse.json({ ...project, requirement_id: req_.id }, { status: 201 })
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add app/api/projects/route.ts
git commit -m "feat: create requirements row eagerly on project creation"
```

---

## Task 4: Vision CRUD API

**Files:**
- Create: `app/api/projects/[id]/vision/route.ts`

GET returns the vision row (creates a draft if none exists). PATCH updates the draft.

- [ ] **Step 1: Create route file**

```typescript
// app/api/projects/[id]/vision/route.ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

type Params = { params: Promise<{ id: string }> }

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Verify ownership
  const { data: project } = await db
    .from('projects').select('id').eq('id', id).eq('owner_id', user.id).single()
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Upsert draft vision row
  const { data: vision, error } = await db
    .from('project_visions')
    .upsert({ project_id: id }, { onConflict: 'project_id', ignoreDuplicates: true })
    .select()
    .maybeSingle()

  if (error) return NextResponse.json({ error: 'DB error' }, { status: 500 })

  // If upsert returned nothing (row already existed), fetch it
  const { data: existing } = vision
    ? { data: vision }
    : await db.from('project_visions').select().eq('project_id', id).single()

  return NextResponse.json(existing)
}

export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: project } = await db
    .from('projects').select('id').eq('id', id).eq('owner_id', user.id).single()
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await req.json()
  const allowed = ['mode', 'free_form_text', 'goal', 'tech_stack', 'target_users', 'key_features', 'constraints']
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  for (const key of allowed) {
    if (key in body) updates[key] = body[key]
  }

  const { data, error } = await db
    .from('project_visions')
    .update(updates)
    .eq('project_id', id)
    .select()
    .single()

  if (error || !data) return NextResponse.json({ error: 'Update failed' }, { status: 500 })
  return NextResponse.json(data)
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add app/api/projects/[id]/vision/route.ts
git commit -m "feat: add vision GET/PATCH API"
```

---

## Task 5: Update Step Indicator

**Files:**
- Modify: `components/agent/step-indicator.tsx`

- [ ] **Step 1: Rewrite step-indicator.tsx**

```typescript
// components/agent/step-indicator.tsx

const ALL_STEPS = [
  { label: 'Vision',       icon: 'auto_awesome' },
  { label: 'Requirement',  icon: 'edit_note' },
  { label: 'Plan',         icon: 'architecture' },
  { label: 'Execution',    icon: 'terminal' },
  { label: 'Review',       icon: 'rate_review' },
]

const PROGRESS_WIDTHS: Record<number, string> = {
  1: 'w-0',
  2: 'w-1/4',
  3: 'w-2/4',
  4: 'w-3/4',
  5: 'w-full',
}

interface Props {
  current: 1 | 2 | 3 | 4 | 5
  /** Skip the Vision step (future imported projects). Shifts current down by 1. */
  skipVision?: boolean
}

export function StepIndicator({ current, skipVision = false }: Props) {
  const steps = skipVision ? ALL_STEPS.slice(1) : ALL_STEPS
  // When skipVision, current 1 = Requirement, 2 = Plan, etc.
  const effectiveCurrent = skipVision ? current : current

  const totalSteps = steps.length
  const progressWidths: Record<number, string> = {
    1: 'w-0',
    2: `w-[${Math.round((1 / (totalSteps - 1)) * 100)}%]`,
    3: `w-[${Math.round((2 / (totalSteps - 1)) * 100)}%]`,
    4: `w-[${Math.round((3 / (totalSteps - 1)) * 100)}%]`,
    5: 'w-full',
  }

  return (
    <div className="bg-[#0b1326]/80 backdrop-blur-md border-b border-white/5 -mx-10 px-10 py-6 mb-10">
      <div className="max-w-4xl mx-auto flex items-center justify-between relative">
        {/* Connector background */}
        <div className="absolute top-5 left-0 w-full h-0.5 bg-surface-container-highest z-0" />
        {/* Connector filled */}
        <div
          className="absolute top-5 left-0 h-0.5 bg-indigo-500 z-0 transition-all duration-500"
          style={{ width: `${((effectiveCurrent - 1) / (steps.length - 1)) * 100}%` }}
        />
        {steps.map((step, i) => {
          const num = i + 1
          const done   = num < effectiveCurrent
          const active = num === effectiveCurrent
          return (
            <div key={step.label} className="relative z-10 flex flex-col items-center gap-2">
              <div className={[
                'w-10 h-10 rounded-full flex items-center justify-center border-4 border-[#0b1326] transition-all',
                active
                  ? 'bg-indigo-500 ring-2 ring-indigo-500/30 shadow-[0_0_16px_rgba(99,102,241,0.4)]'
                  : done
                    ? 'bg-primary'
                    : 'bg-surface-container-high',
              ].join(' ')}>
                {done
                  ? <span className="material-symbols-outlined text-on-primary" style={{ fontSize: '16px' }}>check</span>
                  : <span
                      className={`material-symbols-outlined ${active ? 'text-white' : 'text-slate-500'}`}
                      style={{ fontSize: '16px' }}
                    >
                      {step.icon}
                    </span>
                }
              </div>
              <span className={[
                'text-[10px] font-bold uppercase tracking-tighter font-headline',
                active ? 'text-indigo-400' : done ? 'text-on-surface-variant' : 'text-slate-500',
              ].join(' ')}>
                {step.label}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add components/agent/step-indicator.tsx
git commit -m "feat: expand StepIndicator to 5 steps with Vision"
```

---

## Task 6: Vision Prompt

**Files:**
- Create: `lib/agent/prompts/vision.ts`

- [ ] **Step 1: Create prompt builder**

```typescript
// lib/agent/prompts/vision.ts
import type { ProjectVision } from '@/lib/supabase/types'

export function buildVisionPrompt(vision: ProjectVision): string {
  const content = vision.mode === 'free_form'
    ? vision.free_form_text
    : [
        vision.goal        && `Goal: ${vision.goal}`,
        vision.tech_stack  && `Tech Stack: ${vision.tech_stack}`,
        vision.target_users && `Target Users: ${vision.target_users}`,
        vision.key_features && `Key Features:\n${vision.key_features}`,
        vision.constraints  && `Constraints: ${vision.constraints}`,
      ].filter(Boolean).join('\n\n')

  return `You are a senior requirements analyst. Analyse the following project description and generate a comprehensive, structured list of software requirements.

Return ONLY a JSON array of requirement objects. No prose, no markdown, no explanation — just the JSON array. Each object must have exactly these fields:
- "type": one of "functional", "non-functional", "constraint", "assumption"
- "title": short title, max 10 words
- "description": 1-2 sentence explanation of the requirement
- "priority": one of "high", "medium", "low"

Generate 8-20 requirements covering functional features, non-functional quality attributes (performance, security, scalability), constraints, and key assumptions. Be specific and actionable.

PROJECT DESCRIPTION:
${content}`
}

export const VISION_SYSTEM_PROMPT =
  'You are a senior requirements analyst. Return only valid JSON arrays. No prose, no markdown.'
```

- [ ] **Step 2: Commit**

```bash
git add lib/agent/prompts/vision.ts
git commit -m "feat: add vision generation prompt"
```

---

## Task 7: Vision Generator (Background Logic)

**Files:**
- Create: `lib/agent/vision-generator.ts`

This module contains the background generation logic called fire-and-forget from the API route.

- [ ] **Step 1: Create generator**

```typescript
// lib/agent/vision-generator.ts
import { createClient } from '@supabase/supabase-js'
import { getProvider } from '@/lib/ai/registry'
import { buildVisionPrompt, VISION_SYSTEM_PROMPT } from '@/lib/agent/prompts/vision'
import type { ProjectVision, RequirementItem } from '@/lib/supabase/types'

// Uses service-role client (server-side only, never sent to browser)
function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

async function log(
  db: ReturnType<typeof getServiceClient>,
  projectId: string,
  phase: 'parsing' | 'generating' | 'system',
  message: string,
  level: 'info' | 'warn' | 'error' | 'success' = 'info'
) {
  try {
    await db.from('vision_logs').insert({ project_id: projectId, phase, level, message })
  } catch { /* logging must never abort generation */ }
}

export async function generateVisionRequirements(
  projectId: string,
  vision: ProjectVision,
  requirementId: string
): Promise<void> {
  const db = getServiceClient()

  try {
    await log(db, projectId, 'system', 'Starting requirement generation...')
    await log(db, projectId, 'parsing', 'Parsing your vision...')

    const prompt = buildVisionPrompt(vision)
    const provider = getProvider()

    await log(db, projectId, 'generating', 'Generating requirements with AI...')

    const result = await provider.complete(prompt, {
      maxTokens: 4096,
      temperature: 0,
      responseSchema: {
        type: 'array',
        items: {
          type: 'object',
          required: ['type', 'title', 'description', 'priority'],
          properties: {
            type:        { type: 'string', enum: ['functional', 'non-functional', 'constraint', 'assumption'] },
            title:       { type: 'string' },
            description: { type: 'string' },
            priority:    { type: 'string', enum: ['high', 'medium', 'low'] },
          },
        },
      },
    })

    const items: Array<Pick<RequirementItem, 'type' | 'title' | 'description' | 'priority'>> =
      JSON.parse(result.content)

    if (!Array.isArray(items) || items.length === 0) {
      throw new Error('AI returned no requirement items')
    }

    await log(db, projectId, 'generating', `Inserting ${items.length} requirements...`)

    // Insert one by one so Realtime fires per item
    for (const item of items) {
      await db.from('requirement_items').insert({
        requirement_id: requirementId,
        type:           item.type,
        title:          item.title,
        description:    item.description,
        priority:       item.priority,
        source_text:    null,
        nfr_category:   null,
      })
    }

    // Update raw_input with a formatted summary
    const summary = items
      .map(i => `[${i.type.toUpperCase()}] ${i.title}: ${i.description}`)
      .join('\n')
    await db.from('requirements')
      .update({ raw_input: summary, status: 'draft' })
      .eq('id', requirementId)

    await log(db, projectId, 'system', `Done — ${items.length} requirements generated.`, 'success')

    await db.from('project_visions')
      .update({ status: 'done', error: null, updated_at: new Date().toISOString() })
      .eq('project_id', projectId)

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    await log(db, projectId, 'system', `Generation failed: ${message}`, 'error')
    await db.from('project_visions')
      .update({ status: 'failed', error: message, updated_at: new Date().toISOString() })
      .eq('project_id', projectId)
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add lib/agent/vision-generator.ts lib/agent/prompts/vision.ts
git commit -m "feat: add vision background generator"
```

---

## Task 8: Vision Generate API

**Files:**
- Create: `app/api/projects/[id]/vision/generate/route.ts`

- [ ] **Step 1: Create generate route**

```typescript
// app/api/projects/[id]/vision/generate/route.ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { generateVisionRequirements } from '@/lib/agent/vision-generator'
import type { ProjectVision } from '@/lib/supabase/types'

type Params = { params: Promise<{ id: string }> }

export async function POST(_req: Request, { params }: Params) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Verify project ownership
  const { data: project } = await db
    .from('projects').select('id').eq('id', id).eq('owner_id', user.id).single()
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Load vision
  const { data: vision } = await db
    .from('project_visions').select('*').eq('project_id', id).single()
  if (!vision) return NextResponse.json({ error: 'No vision found' }, { status: 400 })

  // Validate content
  const hasContent = vision.mode === 'free_form'
    ? vision.free_form_text.trim().length > 0
    : vision.goal.trim().length > 0 || vision.key_features.trim().length > 0
  if (!hasContent) return NextResponse.json({ error: 'Vision has no content' }, { status: 400 })

  // Guard: already generating or done
  if (vision.status === 'generating') {
    return NextResponse.json({ error: 'Already generating' }, { status: 409 })
  }

  // Get requirement id
  const { data: req_ } = await db
    .from('requirements').select('id').eq('project_id', id).single()
  if (!req_) return NextResponse.json({ error: 'Requirements row missing' }, { status: 500 })

  // If retrying, clear existing items
  if (vision.status === 'failed' || vision.status === 'done') {
    await db.from('requirement_items').delete().eq('requirement_id', req_.id)
  }

  // Set status to generating
  await db.from('project_visions')
    .update({ status: 'generating', error: null, updated_at: new Date().toISOString() })
    .eq('project_id', id)

  // Fire and forget — Next.js 14 Node.js runtime keeps process alive
  void generateVisionRequirements(id, vision as ProjectVision, req_.id)

  return NextResponse.json({ ok: true }, { status: 202 })
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add app/api/projects/[id]/vision/generate/route.ts
git commit -m "feat: add vision generate API route"
```

---

## Task 9: VisionScreen Component

**Files:**
- Create: `components/agent/vision-screen.tsx`

This is the main client component. It handles three states: **draft** (form), **generating** (live list + log feed), **failed** (error + retry).

- [ ] **Step 1: Create component**

```typescript
// components/agent/vision-screen.tsx
'use client'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { JobShell } from '@/components/agent/job-shell'
import { StepIndicator } from '@/components/agent/step-indicator'
import type { ProjectVision, VisionLog, VisionStatus, RequirementItem } from '@/lib/supabase/types'

// ─── Log feed (reused in sidebar for generating/failed states) ────────────────

const LOG_COLORS: Record<string, string> = {
  info: '#c7c4d7', warn: '#f59e0b', error: '#ffb4ab', success: '#22c55e',
}
const LOG_ICONS: Record<string, string> = {
  info: 'info', warn: 'warning', error: 'error', success: 'check_circle',
}

function LogFeed({ logs }: { logs: VisionLog[] }) {
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
          <span className="material-symbols-outlined mt-0.5 flex-shrink-0"
            style={{ fontSize: '12px', color: LOG_COLORS[log.level] ?? '#c7c4d7' }}>
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

// ─── Structured fields ────────────────────────────────────────────────────────

interface StructuredFields {
  goal: string; tech_stack: string; target_users: string
  key_features: string; constraints: string
}

const STRUCTURED_FIELD_DEFS: { key: keyof StructuredFields; label: string; placeholder: string; multiline?: boolean }[] = [
  { key: 'goal',         label: 'Goal',         placeholder: 'What problem does this project solve?' },
  { key: 'tech_stack',   label: 'Tech Stack',   placeholder: 'e.g. Next.js, Supabase, TypeScript' },
  { key: 'target_users', label: 'Target Users', placeholder: 'Who will use this?' },
  { key: 'key_features', label: 'Key Features', placeholder: 'List the main features, one per line', multiline: true },
  { key: 'constraints',  label: 'Constraints',  placeholder: 'Technical constraints, deadlines, non-goals (optional)', multiline: true },
]

// ─── Main component ───────────────────────────────────────────────────────────

interface Props {
  projectId:     string
  projectName:   string
  requirementId: string
  initialVision: ProjectVision
  initialLogs:   VisionLog[]
  initialItems:  RequirementItem[]
}

const PHASE_LABELS: Record<string, string> = {
  parsing:    'Parsing your vision...',
  generating: 'Generating requirements...',
  system:     'Finalising...',
}

export function VisionScreen({
  projectId, projectName, requirementId,
  initialVision, initialLogs, initialItems,
}: Props) {
  const router = useRouter()
  const db = createClient()

  const [vision,      setVision]      = useState<ProjectVision>(initialVision)
  const [logs,        setLogs]        = useState<VisionLog[]>(initialLogs)
  const [items,       setItems]       = useState<RequirementItem[]>(initialItems)
  const [freeForm,    setFreeForm]    = useState(initialVision.free_form_text)
  const [structured,  setStructured]  = useState<StructuredFields>({
    goal:         initialVision.goal,
    tech_stack:   initialVision.tech_stack,
    target_users: initialVision.target_users,
    key_features: initialVision.key_features,
    constraints:  initialVision.constraints,
  })
  const [mode, setMode]           = useState<'free_form' | 'structured'>(initialVision.mode)
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError]   = useState<string | null>(null)
  const dbRef = useRef(db)

  const status: VisionStatus = vision.status
  const isGenerating = status === 'generating'
  const isFailed     = status === 'failed'
  const latestPhase  = logs.length > 0 ? logs[logs.length - 1].phase : 'system'

  // ── Realtime subscriptions ──────────────────────────────────────────────────
  useEffect(() => {
    const visionChannel = dbRef.current
      .channel(`vision-${projectId}`)
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'project_visions',
        filter: `project_id=eq.${projectId}`,
      }, payload => {
        const updated = payload.new as ProjectVision
        setVision(updated)
        if (updated.status === 'done') {
          router.push(`/projects/${projectId}/requirements`)
        }
      })
      .subscribe()

    const logsChannel = dbRef.current
      .channel(`vision-logs-${projectId}`)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'vision_logs',
        filter: `project_id=eq.${projectId}`,
      }, payload => {
        setLogs(prev => [...prev, payload.new as VisionLog])
      })
      .subscribe()

    const itemsChannel = dbRef.current
      .channel(`vision-items-${projectId}`)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'requirement_items',
        filter: `requirement_id=eq.${requirementId}`,
      }, payload => {
        setItems(prev => [...prev, payload.new as RequirementItem])
      })
      .subscribe()

    return () => {
      dbRef.current.removeChannel(visionChannel)
      dbRef.current.removeChannel(logsChannel)
      dbRef.current.removeChannel(itemsChannel)
    }
  }, [projectId, requirementId, router])

  // ── Auto-save on blur ───────────────────────────────────────────────────────
  async function saveDraft() {
    if (status !== 'draft' && status !== 'failed') return
    await fetch(`/api/projects/${projectId}/vision`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, free_form_text: freeForm, ...structured }),
    })
  }

  async function switchMode(next: 'free_form' | 'structured') {
    setMode(next)
    await fetch(`/api/projects/${projectId}/vision`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: next }),
    })
  }

  async function handleGenerate() {
    setGenerating(true)
    setGenError(null)
    await saveDraft()
    const res = await fetch(`/api/projects/${projectId}/vision/generate`, { method: 'POST' })
    if (!res.ok) {
      const data = await res.json()
      setGenError(data.error ?? 'Failed to start generation')
      setGenerating(false)
      return
    }
    // Status update comes via Realtime
    setGenerating(false)
  }

  const hasContent = mode === 'free_form'
    ? freeForm.trim().length > 0
    : structured.goal.trim().length > 0 || structured.key_features.trim().length > 0

  // ── Sidebar ─────────────────────────────────────────────────────────────────
  const sidebar = (
    <div className="flex flex-col h-full">
      {(isGenerating || isFailed) ? (
        <LogFeed logs={logs} />
      ) : (
        <div className="p-5 space-y-3">
          <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500 font-headline">Tips</p>
          {[
            'Be specific about your tech stack',
            'Describe key user flows',
            'Mention constraints or non-goals',
            'List your primary user types',
          ].map(tip => (
            <div key={tip} className="flex items-start gap-2">
              <span className="material-symbols-outlined text-indigo-400 flex-shrink-0 mt-0.5" style={{ fontSize: '14px' }}>
                lightbulb
              </span>
              <p className="text-xs text-slate-400">{tip}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <JobShell
      projectName={projectName}
      projectId={projectId}
      sidebar={sidebar}
      sidebarTitle={isGenerating || isFailed ? `Agent Activity Log (${logs.length})` : 'Tips'}
    >
      <div className="max-w-4xl mx-auto space-y-8">
        <StepIndicator current={1} />

        {/* ── Generating state ─────────────────────────────────────────────── */}
        {(isGenerating || (status === 'done' && items.length > 0)) && (
          <>
            <div>
              <div className="flex items-center gap-3 mb-2">
                <span className="relative flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-indigo-400" />
                </span>
                <h1 className="text-3xl font-extrabold font-headline tracking-tight text-white">
                  Generating Requirements
                </h1>
              </div>
              <p className="text-slate-400 text-sm">{PHASE_LABELS[latestPhase] ?? 'Processing...'}</p>
            </div>

            <div className="space-y-3">
              {items.map((item, i) => (
                <div key={item.id}
                  className="bg-surface-container rounded-xl p-4 border border-white/5 flex items-start gap-3 animate-fade-in">
                  <span className="material-symbols-outlined text-[#22c55e] flex-shrink-0 mt-0.5" style={{ fontSize: '16px' }}>
                    check_circle
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[10px] font-bold uppercase tracking-widest text-indigo-400 font-headline">
                        {item.type}
                      </span>
                      <span className={`text-[10px] font-bold uppercase ${
                        item.priority === 'high' ? 'text-error' :
                        item.priority === 'medium' ? 'text-tertiary' : 'text-slate-500'
                      }`}>{item.priority}</span>
                    </div>
                    <p className="text-sm font-semibold text-on-surface">{item.title}</p>
                    <p className="text-xs text-slate-400 mt-0.5">{item.description}</p>
                  </div>
                </div>
              ))}
              {isGenerating && (
                <div className="bg-surface-container rounded-xl p-4 border border-indigo-500/30 flex items-center gap-3">
                  <span className="relative flex h-3 w-3 flex-shrink-0">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-3 w-3 bg-indigo-400" />
                  </span>
                  <span className="text-sm text-indigo-300">Generating next requirement...</span>
                </div>
              )}
            </div>
          </>
        )}

        {/* ── Failed state ──────────────────────────────────────────────────── */}
        {isFailed && (
          <>
            <div>
              <h1 className="text-3xl font-extrabold font-headline tracking-tight text-white mb-2">
                Generation Failed
              </h1>
              <p className="text-slate-400 text-sm">Review the error below and try again.</p>
            </div>
            <div className="bg-error-container/10 rounded-xl p-6 border border-error/30">
              <div className="flex items-start gap-3">
                <span className="material-symbols-outlined text-error flex-shrink-0" style={{ fontSize: '24px' }}>error</span>
                <div>
                  <h3 className="font-headline font-bold text-error mb-1">Error</h3>
                  <p className="text-sm text-on-surface-variant font-mono leading-relaxed">
                    {vision.error ?? 'Unknown error'}
                  </p>
                </div>
              </div>
              <button
                onClick={handleGenerate}
                disabled={generating}
                className="mt-4 bg-gradient-to-br from-primary to-primary-container text-on-primary-container px-6 py-2.5 rounded-lg font-headline font-extrabold text-sm flex items-center gap-2 disabled:opacity-60"
              >
                {generating ? 'Retrying...' : 'Retry'}
                {!generating && <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>refresh</span>}
              </button>
            </div>
          </>
        )}

        {/* ── Draft state ───────────────────────────────────────────────────── */}
        {(status === 'draft') && (
          <>
            <div className="flex items-start justify-between">
              <div>
                <h1 className="text-3xl font-extrabold font-headline tracking-tight text-white mb-2">
                  Describe Your Project
                </h1>
                <p className="text-slate-400 text-sm">
                  Tell us what you&apos;re building — the AI will generate structured requirements from your description.
                </p>
              </div>
              <div className="flex items-center gap-3 flex-shrink-0 ml-6">
                {genError && <span className="text-xs text-error font-mono">{genError}</span>}
                <button
                  onClick={handleGenerate}
                  disabled={!hasContent || generating}
                  className="bg-gradient-to-br from-primary to-primary-container text-on-primary-container px-6 py-2.5 rounded-lg font-headline font-extrabold text-sm flex items-center gap-2 shadow-[0_4px_20px_rgba(189,194,255,0.2)] hover:scale-[1.02] transition-transform active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed disabled:scale-100"
                >
                  {generating ? 'Starting...' : 'Generate Requirements'}
                  {!generating && <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>arrow_forward</span>}
                </button>
              </div>
            </div>

            {/* Mode toggle */}
            <div className="flex items-center gap-1 p-1 bg-surface-container-low rounded-xl w-fit">
              {(['free_form', 'structured'] as const).map(m => (
                <button
                  key={m}
                  onClick={() => switchMode(m)}
                  className={[
                    'px-4 py-1.5 rounded-lg text-xs font-bold font-headline uppercase tracking-wider transition-all',
                    mode === m
                      ? 'bg-indigo-500/20 text-indigo-300 ring-1 ring-indigo-500/40'
                      : 'text-slate-400 hover:text-slate-200',
                  ].join(' ')}
                >
                  {m === 'free_form' ? 'Free-form' : 'Structured'}
                </button>
              ))}
            </div>

            {/* Free-form */}
            {mode === 'free_form' && (
              <textarea
                value={freeForm}
                onChange={e => setFreeForm(e.target.value)}
                onBlur={saveDraft}
                placeholder="Describe what you're building — goals, key features, tech stack, target users, constraints..."
                rows={14}
                className="w-full bg-surface-container rounded-xl p-5 text-sm text-on-surface border border-white/5 focus:border-indigo-500/40 focus:outline-none resize-none font-mono leading-relaxed placeholder:text-slate-600 transition-colors"
              />
            )}

            {/* Structured fields */}
            {mode === 'structured' && (
              <div className="space-y-4">
                {STRUCTURED_FIELD_DEFS.map(field => (
                  <div key={field.key}>
                    <label className="block text-[10px] font-bold uppercase tracking-widest text-slate-400 font-headline mb-1.5">
                      {field.label}
                    </label>
                    {field.multiline ? (
                      <textarea
                        value={structured[field.key]}
                        onChange={e => setStructured(prev => ({ ...prev, [field.key]: e.target.value }))}
                        onBlur={saveDraft}
                        placeholder={field.placeholder}
                        rows={4}
                        className="w-full bg-surface-container rounded-xl p-4 text-sm text-on-surface border border-white/5 focus:border-indigo-500/40 focus:outline-none resize-none placeholder:text-slate-600 transition-colors"
                      />
                    ) : (
                      <input
                        type="text"
                        value={structured[field.key]}
                        onChange={e => setStructured(prev => ({ ...prev, [field.key]: e.target.value }))}
                        onBlur={saveDraft}
                        placeholder={field.placeholder}
                        className="w-full bg-surface-container rounded-xl px-4 py-3 text-sm text-on-surface border border-white/5 focus:border-indigo-500/40 focus:outline-none placeholder:text-slate-600 transition-colors"
                      />
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
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

- [ ] **Step 3: Commit**

```bash
git add components/agent/vision-screen.tsx
git commit -m "feat: add VisionScreen component"
```

---

## Task 10: Vision Page

**Files:**
- Create: `app/projects/[id]/vision/page.tsx`

- [ ] **Step 1: Create server page**

```typescript
// app/projects/[id]/vision/page.tsx
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { VisionScreen } from '@/components/agent/vision-screen'
import type { ProjectVision, VisionLog, RequirementItem } from '@/lib/supabase/types'

interface Props {
  params: Promise<{ id: string }>
}

export default async function VisionPage({ params }: Props) {
  const { id: projectId } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) redirect('/login')

  const { data: project } = await db
    .from('projects')
    .select('id, name, setup_mode')
    .eq('id', projectId)
    .eq('owner_id', user.id)
    .single()

  if (!project) redirect('/projects')

  // Ensure requirements row exists
  let { data: req } = await db
    .from('requirements')
    .select('id')
    .eq('project_id', projectId)
    .maybeSingle()

  if (!req) {
    const { data: created } = await db
      .from('requirements')
      .insert({ project_id: projectId, title: 'Requirements', raw_input: '', status: 'draft' })
      .select('id')
      .single()
    req = created
  }

  if (!req) redirect('/projects')

  // Upsert vision row
  await db.from('project_visions')
    .upsert({ project_id: projectId }, { onConflict: 'project_id', ignoreDuplicates: true })

  const { data: vision } = await db
    .from('project_visions')
    .select('*')
    .eq('project_id', projectId)
    .single()

  if (!vision) redirect('/projects')

  // If already done, skip to requirements
  if (vision.status === 'done') {
    redirect(`/projects/${projectId}/requirements`)
  }

  const [{ data: logs }, { data: items }] = await Promise.all([
    db.from('vision_logs').select('*').eq('project_id', projectId).order('created_at', { ascending: true }),
    db.from('requirement_items').select('*').eq('requirement_id', req.id).order('created_at', { ascending: true }),
  ])

  return (
    <VisionScreen
      projectId={projectId}
      projectName={project.name}
      requirementId={req.id}
      initialVision={vision as ProjectVision}
      initialLogs={(logs ?? []) as VisionLog[]}
      initialItems={(items ?? []) as RequirementItem[]}
    />
  )
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add app/projects/[id]/vision/page.tsx
git commit -m "feat: add vision page"
```

---

## Task 11: Wire Up CreateProjectForm

**Files:**
- Modify: `components/projects/create-project-form.tsx`

- [ ] **Step 1: Update redirect target**

Change the `router.push` after project creation from `/requirements` to `/vision`:

```typescript
const project = await res.json()
router.push(`/projects/${project.id}/vision`)
```

The full updated `handleSubmit`:

```typescript
async function handleSubmit(e: React.FormEvent) {
  e.preventDefault()
  setLoading(true)
  setError(null)
  try {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    if (!res.ok) {
      const data = await res.json()
      setError(data.error ?? 'Failed to create project')
      return
    }
    const project = await res.json()
    router.push(`/projects/${project.id}/vision`)
  } finally {
    setLoading(false)
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add components/projects/create-project-form.tsx
git commit -m "feat: redirect new projects to vision step"
```

---

## Task 12: Bump Existing Step Numbers

**Files:**
- Modify: `app/projects/[id]/requirements/page.tsx`
- Modify: `components/agent/plan-screen.tsx`
- Modify: `components/agent/execution-screen.tsx`
- Modify: `components/agent/review-screen.tsx`

All existing screens shift up by one because Vision is now step 1.

- [ ] **Step 1: Update requirements page — step 1 → 2**

In `app/projects/[id]/requirements/page.tsx`, change:

```typescript
<StepIndicator current={1} />
```
to:
```typescript
<StepIndicator current={2} />
```

- [ ] **Step 2: Update plan screen — step 2 → 3**

In `components/agent/plan-screen.tsx`, change:

```typescript
<StepIndicator current={2} />
```
to:
```typescript
<StepIndicator current={3} />
```

- [ ] **Step 3: Update execution screen — step 3 → 4**

In `components/agent/execution-screen.tsx`, change:

```typescript
<StepIndicator current={3} />
```
to:
```typescript
<StepIndicator current={4} />
```

- [ ] **Step 4: Update review screen — step 4 → 5**

In `components/agent/review-screen.tsx`, change:

```typescript
<StepIndicator current={4} />
```
to:
```typescript
<StepIndicator current={5} />
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Smoke test the full flow manually**

1. Create a new project → should land on `/vision`
2. Toggle between Free-form and Structured — both should save on blur
3. Click Generate with content → sidebar should show log feed, items should appear
4. After generation completes → should auto-navigate to `/requirements` with items pre-populated
5. Navigate to Plan/Execution/Review screens — step indicator should show steps 3/4/5 correctly

- [ ] **Step 7: Commit**

```bash
git add app/projects/[id]/requirements/page.tsx components/agent/plan-screen.tsx components/agent/execution-screen.tsx components/agent/review-screen.tsx
git commit -m "feat: bump step numbers for 5-step Vision flow"
```
