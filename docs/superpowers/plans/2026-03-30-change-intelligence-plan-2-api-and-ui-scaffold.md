# Change Intelligence System — Plan 2: API Layer + UI Scaffold

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace old project/jobs/requirements API routes with the Change Intelligence API, add change-request CRUD endpoints, update the project creation form, and scaffold the project dashboard + change intake UI.

**Architecture:** Extract pure validator functions (testable without DB) for change-request creation and updates. API routes call validators then write to DB. Project dashboard polls `scan_status` every 3s while scanning. Change intake form POSTs to `/api/change-requests` and redirects to the new change detail page. No analysis engine yet — analysis is Plan 4.

**Tech Stack:** Next.js 14 App Router, TypeScript, Tailwind CSS, Supabase, Vitest

---

## File Structure

| Action | Path | Responsibility |
|--------|------|----------------|
| Delete | `app/api/jobs/` | Old job routes — replaced |
| Delete | `app/api/requirements/` | Old requirements routes — replaced |
| Delete | `app/api/gaps/` | Old gaps route — replaced |
| Delete | `app/api/questions/` | Old questions route — replaced |
| Delete | `app/api/investigation-tasks/` | Old investigation-tasks route — replaced |
| Delete | `app/projects/[id]/vision/` | Old vision page — replaced |
| Delete | `app/projects/[id]/requirements/` | Old requirements page — replaced |
| Delete | `app/projects/[id]/jobs/` | Old job pages — replaced |
| Delete | `lib/agent/` | Old agent loop — replaced |
| Delete | `lib/requirements/` | Old requirements pipeline — replaced |
| Delete | `components/agent/` | Old agent UI components — replaced |
| Delete | `components/requirements/` | Old requirements UI — replaced |
| Modify | `app/api/projects/route.ts` | POST: new schema (repo_url, repo_token, scan_status); GET unchanged |
| Modify | `app/api/projects/[id]/route.ts` | GET/PATCH: new columns; remove old columns |
| Create | `app/api/projects/[id]/system-model/route.ts` | GET: list components + assignments |
| Create | `lib/change-requests/validator.ts` | Pure validation functions for CRUD |
| Create | `tests/lib/change-requests/validator.test.ts` | Unit tests for validator |
| Create | `app/api/change-requests/route.ts` | POST: create change request |
| Create | `app/api/change-requests/[id]/route.ts` | GET/PATCH: change request detail |
| Modify | `components/projects/create-project-form.tsx` | Add repo_url + repo_token fields; redirect to dashboard |
| Modify | `components/projects/project-list.tsx` | Link to `/projects/[id]` instead of old `/requirements` |
| Create | `app/projects/[id]/page.tsx` | Project dashboard: scan status strip + change list |
| Create | `app/projects/[id]/changes/new/page.tsx` | Change intake page (thin wrapper) |
| Create | `components/change/change-intake-form.tsx` | Change intake form component |
| Create | `app/projects/[id]/changes/[changeId]/page.tsx` | Change detail page (status + basic info) |

---

### Task 1: Delete old routes, pages, and library code

**Files:**
- Delete: `app/api/jobs/`
- Delete: `app/api/requirements/`
- Delete: `app/api/gaps/`
- Delete: `app/api/questions/`
- Delete: `app/api/investigation-tasks/`
- Delete: `app/projects/[id]/vision/`
- Delete: `app/projects/[id]/requirements/`
- Delete: `app/projects/[id]/jobs/`
- Delete: `lib/agent/`
- Delete: `lib/requirements/`
- Delete: `components/agent/`
- Delete: `components/requirements/`

- [ ] **Step 1: Delete old directories**

```bash
rm -rf app/api/jobs app/api/requirements app/api/gaps app/api/questions app/api/investigation-tasks
rm -rf app/projects/[id]/vision app/projects/[id]/requirements "app/projects/[id]/jobs"
rm -rf lib/agent lib/requirements
rm -rf components/agent components/requirements
```

- [ ] **Step 2: Verify TypeScript compiles (errors expected in test files only)**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | grep -v "tests/" | head -20
```

Expected: 0 errors outside `tests/`. If errors appear outside `tests/`, fix them before proceeding.

- [ ] **Step 3: Delete old test files for deleted code**

```bash
rm -rf tests/api/requirements tests/lib/requirements tests/lib/agent
```

- [ ] **Step 4: Run remaining tests**

```bash
npm test 2>&1 | tail -10
```

Expected: all remaining tests pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: delete old agent/requirements/jobs routes and library code"
```

---

### Task 2: Update projects API — POST and GET

**Files:**
- Modify: `app/api/projects/route.ts`
- Modify: `app/api/projects/[id]/route.ts`

- [ ] **Step 1: Replace `app/api/projects/route.ts`**

```typescript
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET() {
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: projects } = await db
    .from('projects')
    .select('id, name, scan_status, created_at')
    .eq('owner_id', user.id)
    .order('created_at', { ascending: false })

  return NextResponse.json(projects ?? [])
}

export async function POST(req: Request) {
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }

  const insert: Record<string, unknown> = {
    name: body.name.trim(),
    owner_id: user.id,
    scan_status: 'pending',
  }
  if (typeof body.repo_url === 'string' && body.repo_url.trim()) {
    insert.repo_url = body.repo_url.trim()
  }
  if (typeof body.repo_token === 'string' && body.repo_token.trim()) {
    insert.repo_token = body.repo_token.trim()
  }

  const { data: project, error } = await db
    .from('projects')
    .insert(insert)
    .select('id, name, scan_status, repo_url, created_at')
    .single()

  if (error || !project) {
    return NextResponse.json({ error: 'Failed to create project' }, { status: 500 })
  }

  return NextResponse.json(project, { status: 201 })
}
```

- [ ] **Step 2: Replace `app/api/projects/[id]/route.ts`**

```typescript
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: project } = await db
    .from('projects')
    .select('id, name, owner_id, repo_url, scan_status, scan_error, lock_version, created_at')
    .eq('id', id)
    .eq('owner_id', user.id)
    .single()

  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(project)
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const updates: Record<string, unknown> = {}
  if (typeof body.repo_url === 'string') updates.repo_url = body.repo_url.trim() || null
  if (typeof body.repo_token === 'string') updates.repo_token = body.repo_token.trim() || null
  if (typeof body.name === 'string' && body.name.trim()) updates.name = body.name.trim()

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }

  const { data, error } = await db
    .from('projects')
    .update(updates)
    .eq('id', id)
    .eq('owner_id', user.id)
    .select('id, name, repo_url, scan_status, lock_version')
    .single()

  if (error || !data) return NextResponse.json({ error: 'Update failed' }, { status: 500 })
  return NextResponse.json(data)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { error } = await db
    .from('projects')
    .delete()
    .eq('id', id)
    .eq('owner_id', user.id)

  if (error) return NextResponse.json({ error: 'Delete failed' }, { status: 500 })
  return new NextResponse(null, { status: 204 })
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | grep -v "tests/" | head -20
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add app/api/projects/route.ts app/api/projects/[id]/route.ts
git commit -m "feat: update projects API to Change Intelligence schema"
```

---

### Task 3: Add system-model endpoint

**Files:**
- Create: `app/api/projects/[id]/system-model/route.ts`

Returns the list of system components and their file assignments for a project. Empty until the scanner runs (Plan 3).

- [ ] **Step 1: Create `app/api/projects/[id]/system-model/route.ts`**

```typescript
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Verify project ownership
  const { data: project } = await db
    .from('projects')
    .select('id, scan_status')
    .eq('id', id)
    .eq('owner_id', user.id)
    .single()

  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: components } = await db
    .from('system_components')
    .select('id, name, type, status, is_anchored, scan_count, last_updated, deleted_at')
    .eq('project_id', id)
    .is('deleted_at', null)
    .order('name')

  const componentIds = (components ?? []).map(c => c.id)

  const { data: assignments } = componentIds.length > 0
    ? await db
        .from('component_assignment')
        .select('file_id, component_id, confidence, is_primary, status')
        .in('component_id', componentIds)
        .eq('is_primary', true)
    : { data: [] }

  const stable = (components ?? []).filter(c => c.status === 'stable').length
  const unstable = (components ?? []).filter(c => c.status === 'unstable').length

  return NextResponse.json({
    scan_status: project.scan_status,
    components: components ?? [],
    assignments: assignments ?? [],
    stats: {
      total: (components ?? []).length,
      stable,
      unstable,
    },
  })
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | grep -v "tests/" | head -10
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add app/api/projects/[id]/system-model/route.ts
git commit -m "feat: add system-model GET endpoint (returns empty until scanner runs)"
```

---

### Task 4: Change-request validator — TDD

**Files:**
- Create: `lib/change-requests/validator.ts`
- Create: `tests/lib/change-requests/validator.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/change-requests/validator.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import {
  validateCreateChangeRequest,
  validatePatchChangeRequest,
} from '@/lib/change-requests/validator'

describe('validateCreateChangeRequest', () => {
  const valid = {
    title: 'Fix auth bug',
    intent: 'Users cannot log in with OAuth providers',
    type: 'bug',
    priority: 'high',
    tags: ['auth', 'critical'],
  }

  it('accepts a valid create payload', () => {
    const result = validateCreateChangeRequest(valid)
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.data.title).toBe('Fix auth bug')
      expect(result.data.type).toBe('bug')
      expect(result.data.priority).toBe('high')
      expect(result.data.tags).toEqual(['auth', 'critical'])
    }
  })

  it('defaults priority to medium when missing', () => {
    const result = validateCreateChangeRequest({ ...valid, priority: undefined })
    expect(result.valid).toBe(true)
    if (result.valid) expect(result.data.priority).toBe('medium')
  })

  it('defaults tags to empty array when missing', () => {
    const result = validateCreateChangeRequest({ ...valid, tags: undefined })
    expect(result.valid).toBe(true)
    if (result.valid) expect(result.data.tags).toEqual([])
  })

  it('trims whitespace from title and intent', () => {
    const result = validateCreateChangeRequest({ ...valid, title: '  Fix auth  ', intent: '  Users cannot log in  ' })
    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.data.title).toBe('Fix auth')
      expect(result.data.intent).toBe('Users cannot log in')
    }
  })

  it('rejects missing title', () => {
    const result = validateCreateChangeRequest({ ...valid, title: '' })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.error).toContain('title')
  })

  it('rejects missing intent', () => {
    const result = validateCreateChangeRequest({ ...valid, intent: '' })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.error).toContain('intent')
  })

  it('rejects invalid type', () => {
    const result = validateCreateChangeRequest({ ...valid, type: 'unknown' })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.error).toContain('type')
  })

  it('rejects non-object input', () => {
    expect(validateCreateChangeRequest(null)).toEqual({ valid: false, error: 'body must be an object' })
    expect(validateCreateChangeRequest('string')).toEqual({ valid: false, error: 'body must be an object' })
  })
})

describe('validatePatchChangeRequest', () => {
  it('accepts a valid title update', () => {
    const result = validatePatchChangeRequest({ title: 'New title' })
    expect(result.valid).toBe(true)
    if (result.valid) expect(result.updates.title).toBe('New title')
  })

  it('accepts a valid priority update', () => {
    const result = validatePatchChangeRequest({ priority: 'low' })
    expect(result.valid).toBe(true)
    if (result.valid) expect(result.updates.priority).toBe('low')
  })

  it('accepts a valid tags update', () => {
    const result = validatePatchChangeRequest({ tags: ['a', 'b'] })
    expect(result.valid).toBe(true)
    if (result.valid) expect(result.updates.tags).toEqual(['a', 'b'])
  })

  it('rejects empty payload', () => {
    const result = validatePatchChangeRequest({})
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.error).toContain('nothing')
  })

  it('rejects invalid priority', () => {
    const result = validatePatchChangeRequest({ priority: 'urgent' })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.error).toContain('priority')
  })

  it('rejects tags that are not strings', () => {
    const result = validatePatchChangeRequest({ tags: [1, 2] })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.error).toContain('tags')
  })

  it('rejects empty title', () => {
    const result = validatePatchChangeRequest({ title: '  ' })
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.error).toContain('title')
  })
})
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npx vitest run tests/lib/change-requests/validator.test.ts 2>&1 | tail -10
```

Expected: FAIL — `Cannot find module '@/lib/change-requests/validator'`

- [ ] **Step 3: Create `lib/change-requests/validator.ts`**

```typescript
import type { ChangeType, ChangePriority } from '@/lib/supabase/types'

const CHANGE_TYPES: ChangeType[] = ['bug', 'feature', 'refactor', 'hotfix']
const CHANGE_PRIORITIES: ChangePriority[] = ['low', 'medium', 'high']

type CreateResult =
  | { valid: true; data: { title: string; intent: string; type: ChangeType; priority: ChangePriority; tags: string[] } }
  | { valid: false; error: string }

type PatchResult =
  | { valid: true; updates: Record<string, unknown> }
  | { valid: false; error: string }

export function validateCreateChangeRequest(body: unknown): CreateResult {
  if (typeof body !== 'object' || body === null) return { valid: false, error: 'body must be an object' }
  const b = body as Record<string, unknown>

  if (typeof b.title !== 'string' || !b.title.trim()) return { valid: false, error: 'title is required' }
  if (typeof b.intent !== 'string' || !b.intent.trim()) return { valid: false, error: 'intent is required' }
  if (!CHANGE_TYPES.includes(b.type as ChangeType)) {
    return { valid: false, error: `type must be one of: ${CHANGE_TYPES.join(', ')}` }
  }

  const priority: ChangePriority = CHANGE_PRIORITIES.includes(b.priority as ChangePriority)
    ? (b.priority as ChangePriority)
    : 'medium'

  const tags =
    Array.isArray(b.tags) && b.tags.every(t => typeof t === 'string')
      ? (b.tags as string[])
      : []

  return {
    valid: true,
    data: {
      title: b.title.trim(),
      intent: b.intent.trim(),
      type: b.type as ChangeType,
      priority,
      tags,
    },
  }
}

export function validatePatchChangeRequest(body: unknown): PatchResult {
  if (typeof body !== 'object' || body === null) return { valid: false, error: 'body must be an object' }
  const b = body as Record<string, unknown>
  const updates: Record<string, unknown> = {}

  if (b.title !== undefined) {
    if (typeof b.title !== 'string' || !b.title.trim()) return { valid: false, error: 'title must be a non-empty string' }
    updates.title = b.title.trim()
  }
  if (b.priority !== undefined) {
    if (!CHANGE_PRIORITIES.includes(b.priority as ChangePriority)) {
      return { valid: false, error: `priority must be one of: ${CHANGE_PRIORITIES.join(', ')}` }
    }
    updates.priority = b.priority
  }
  if (b.tags !== undefined) {
    if (!Array.isArray(b.tags) || !b.tags.every(t => typeof t === 'string')) {
      return { valid: false, error: 'tags must be an array of strings' }
    }
    updates.tags = b.tags
  }

  if (Object.keys(updates).length === 0) return { valid: false, error: 'nothing to update' }
  return { valid: true, updates }
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npx vitest run tests/lib/change-requests/validator.test.ts 2>&1 | tail -10
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/change-requests/validator.ts tests/lib/change-requests/validator.test.ts
git commit -m "feat: add change-request validator with TDD"
```

---

### Task 5: Change-request API routes

**Files:**
- Create: `app/api/change-requests/route.ts`
- Create: `app/api/change-requests/[id]/route.ts`

- [ ] **Step 1: Create `app/api/change-requests/route.ts`**

```typescript
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { validateCreateChangeRequest } from '@/lib/change-requests/validator'

export async function POST(req: Request) {
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const validation = validateCreateChangeRequest(body)
  if (!validation.valid) return NextResponse.json({ error: validation.error }, { status: 400 })

  if (!body.project_id || typeof body.project_id !== 'string') {
    return NextResponse.json({ error: 'project_id is required' }, { status: 400 })
  }

  // Verify project ownership
  const { data: project } = await db
    .from('projects')
    .select('id')
    .eq('id', body.project_id)
    .eq('owner_id', user.id)
    .single()

  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const { data: change, error } = await db
    .from('change_requests')
    .insert({
      project_id: body.project_id,
      title: validation.data.title,
      intent: validation.data.intent,
      type: validation.data.type,
      priority: validation.data.priority,
      tags: validation.data.tags,
      status: 'open',
      triggered_by: 'user',
      created_by: user.id,
    })
    .select('id, project_id, title, intent, type, priority, status, tags, created_at')
    .single()

  if (error || !change) {
    return NextResponse.json({ error: 'Failed to create change request' }, { status: 500 })
  }

  return NextResponse.json(change, { status: 201 })
}
```

- [ ] **Step 2: Create `app/api/change-requests/[id]/route.ts`**

```typescript
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { validatePatchChangeRequest } from '@/lib/change-requests/validator'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: change } = await db
    .from('change_requests')
    .select(`
      id, project_id, title, intent, type, priority, status,
      risk_level, confidence_score, confidence_breakdown, analysis_quality,
      lock_version, execution_group, triggered_by, tags, created_at, updated_at,
      projects!inner(owner_id)
    `)
    .eq('id', id)
    .eq('projects.owner_id', user.id)
    .single()

  if (!change) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Fetch related impact if analyzed
  const { data: impact } = await db
    .from('change_impacts')
    .select('id, risk_score, blast_radius, primary_risk_factor, analysis_quality, requires_migration, requires_data_change')
    .eq('change_id', id)
    .maybeSingle()

  const { data: riskFactors } = impact
    ? await db
        .from('change_risk_factors')
        .select('factor, weight')
        .eq('change_id', id)
        .order('weight', { ascending: false })
    : { data: [] }

  const { data: impactComponents } = impact
    ? await db
        .from('change_impact_components')
        .select('component_id, impact_weight, source, source_detail, system_components(name, type)')
        .eq('impact_id', impact.id)
        .order('impact_weight', { ascending: false })
        .limit(10)
    : { data: [] }

  return NextResponse.json({
    ...change,
    impact: impact ?? null,
    risk_factors: riskFactors ?? [],
    impact_components: impactComponents ?? [],
  })
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Verify ownership via project
  const { data: change } = await db
    .from('change_requests')
    .select('id, projects!inner(owner_id)')
    .eq('id', id)
    .eq('projects.owner_id', user.id)
    .single()

  if (!change) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await req.json()
  const validation = validatePatchChangeRequest(body)
  if (!validation.valid) return NextResponse.json({ error: validation.error }, { status: 400 })

  const { data, error } = await db
    .from('change_requests')
    .update({ ...validation.updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('id, title, priority, tags, status, updated_at')
    .single()

  if (error || !data) return NextResponse.json({ error: 'Update failed' }, { status: 500 })
  return NextResponse.json(data)
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | grep -v "tests/" | head -10
```

Expected: 0 errors.

- [ ] **Step 4: Run all tests**

```bash
npm test 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/api/change-requests/route.ts app/api/change-requests/[id]/route.ts
git commit -m "feat: add change-request CRUD API endpoints"
```

---

### Task 6: Update project creation form and project list

**Files:**
- Modify: `components/projects/create-project-form.tsx`
- Modify: `components/projects/project-list.tsx`

- [ ] **Step 1: Replace `components/projects/create-project-form.tsx`**

The form now collects `name`, `repo_url` (optional), and `repo_token` (optional). On success, redirects to `/projects/[id]` (the new dashboard).

```tsx
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'

export function CreateProjectForm() {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [repoUrl, setRepoUrl] = useState('')
  const [repoToken, setRepoToken] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

  function reset() {
    setOpen(false)
    setName('')
    setRepoUrl('')
    setRepoToken('')
    setError(null)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          repo_url: repoUrl || undefined,
          repo_token: repoToken || undefined,
        }),
      })
      if (!res.ok) {
        const data = await res.json()
        setError(data.error ?? 'Failed to create project')
        return
      }
      const project = await res.json()
      router.push(`/projects/${project.id}`)
    } finally {
      setLoading(false)
    }
  }

  const inputStyle = {
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border-default)',
    color: 'var(--text-primary)',
    fontFamily: 'var(--font-dm-sans)',
  }

  if (!open) {
    return <Button onClick={() => setOpen(true)}>+ New Project</Button>
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 p-4 rounded-xl border border-white/10 bg-[#131b2e] w-80">
      <p className="text-xs font-bold uppercase tracking-widest text-indigo-400 font-headline">New Project</p>

      <input
        autoFocus
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder="Project name"
        required
        className="w-full rounded-lg px-3 py-2 text-sm outline-none transition-all"
        style={inputStyle}
        onFocus={e => { e.currentTarget.style.borderColor = 'var(--border-accent)' }}
        onBlur={e => { e.currentTarget.style.borderColor = 'var(--border-default)' }}
      />

      <input
        value={repoUrl}
        onChange={e => setRepoUrl(e.target.value)}
        placeholder="GitHub repo URL (optional)"
        className="w-full rounded-lg px-3 py-2 text-sm outline-none transition-all"
        style={inputStyle}
        onFocus={e => { e.currentTarget.style.borderColor = 'var(--border-accent)' }}
        onBlur={e => { e.currentTarget.style.borderColor = 'var(--border-default)' }}
      />

      <input
        value={repoToken}
        onChange={e => setRepoToken(e.target.value)}
        placeholder="GitHub token (optional)"
        type="password"
        className="w-full rounded-lg px-3 py-2 text-sm outline-none transition-all"
        style={inputStyle}
        onFocus={e => { e.currentTarget.style.borderColor = 'var(--border-accent)' }}
        onBlur={e => { e.currentTarget.style.borderColor = 'var(--border-default)' }}
      />

      <div className="flex items-center gap-2 pt-1">
        <Button type="submit" loading={loading}>Create</Button>
        <Button type="button" variant="ghost" onClick={reset}>Cancel</Button>
      </div>

      {error && <p className="text-xs" style={{ color: 'var(--danger)' }}>{error}</p>}
    </form>
  )
}
```

- [ ] **Step 2: Update link in `components/projects/project-list.tsx`**

Change the `href` on the project link from `/projects/${p.id}/requirements` to `/projects/${p.id}`:

```tsx
// Find this line:
href={`/projects/${p.id}/requirements`}

// Replace with:
href={`/projects/${p.id}`}
```

Also update the `Project` interface to include `scan_status`:

```tsx
interface Project {
  id: string
  name: string
  scan_status: string
  created_at: string
}
```

And update the list item to show `scan_status`:

```tsx
// After the project name span, add:
<span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded font-mono ${
  p.scan_status === 'ready' ? 'text-green-400 bg-green-400/10' :
  p.scan_status === 'scanning' ? 'text-indigo-400 bg-indigo-400/10' :
  p.scan_status === 'failed' ? 'text-red-400 bg-red-400/10' :
  'text-slate-500 bg-slate-500/10'
}`}>{p.scan_status}</span>
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | grep -v "tests/" | head -10
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add components/projects/create-project-form.tsx components/projects/project-list.tsx
git commit -m "feat: update project form with repo fields, update list links to new dashboard"
```

---

### Task 7: Project dashboard page

**Files:**
- Create: `app/projects/[id]/page.tsx`

Server component that loads project + change list. Client-side polling every 3s while `scan_status = 'scanning'`.

- [ ] **Step 1: Create `app/projects/[id]/page.tsx`**

```tsx
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ProjectDashboard } from './project-dashboard'

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) redirect('/login')

  const { data: project } = await db
    .from('projects')
    .select('id, name, scan_status, scan_error, repo_url, created_at')
    .eq('id', id)
    .eq('owner_id', user.id)
    .single()

  if (!project) redirect('/projects')

  const { data: changes } = await db
    .from('change_requests')
    .select('id, title, type, priority, status, risk_level, created_at, updated_at')
    .eq('project_id', id)
    .order('updated_at', { ascending: false })

  return <ProjectDashboard project={project} initialChanges={changes ?? []} />
}
```

- [ ] **Step 2: Create `app/projects/[id]/project-dashboard.tsx`**

```tsx
'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { LeftNav } from '@/components/app/left-nav'
import { ProfileAvatar } from '@/components/app/profile-avatar'

interface Project {
  id: string
  name: string
  scan_status: string
  scan_error: string | null
  repo_url: string | null
  created_at: string
}

interface Change {
  id: string
  title: string
  type: string
  priority: string
  status: string
  risk_level: string | null
  created_at: string
  updated_at: string
}

const TYPE_COLORS: Record<string, string> = {
  bug: 'text-red-400 bg-red-400/10',
  feature: 'text-indigo-400 bg-indigo-400/10',
  refactor: 'text-amber-400 bg-amber-400/10',
  hotfix: 'text-orange-400 bg-orange-400/10',
}
const RISK_COLORS: Record<string, string> = {
  low: 'text-green-400 bg-green-400/10',
  medium: 'text-amber-400 bg-amber-400/10',
  high: 'text-red-400 bg-red-400/10',
}
const STATUS_COLORS: Record<string, string> = {
  open: 'text-slate-400 bg-slate-400/10',
  analyzing: 'text-indigo-400 bg-indigo-400/10',
  analyzing_mapping: 'text-indigo-400 bg-indigo-400/10',
  analyzing_propagation: 'text-indigo-400 bg-indigo-400/10',
  analyzing_scoring: 'text-indigo-400 bg-indigo-400/10',
  analyzed: 'text-blue-400 bg-blue-400/10',
  planned: 'text-purple-400 bg-purple-400/10',
  executing: 'text-amber-400 bg-amber-400/10',
  review: 'text-orange-400 bg-orange-400/10',
  done: 'text-green-400 bg-green-400/10',
  failed: 'text-red-400 bg-red-400/10',
}

function Badge({ label, colorClass }: { label: string; colorClass: string }) {
  return (
    <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded font-mono ${colorClass}`}>
      {label}
    </span>
  )
}

function ScanStatusStrip({ project }: { project: Project }) {
  const isScanning = project.scan_status === 'scanning'
  return (
    <div className="flex items-center gap-3 px-5 py-3 rounded-xl bg-[#131b2e] border border-white/5">
      {isScanning ? (
        <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-indigo-400" />
        </span>
      ) : (
        <span className={`h-2.5 w-2.5 rounded-full flex-shrink-0 ${
          project.scan_status === 'ready' ? 'bg-green-400' :
          project.scan_status === 'failed' ? 'bg-red-400' : 'bg-slate-500'
        }`} />
      )}
      <div className="flex-1 min-w-0">
        <span className="text-xs text-slate-400">
          {isScanning ? 'Scanning repository…' :
           project.scan_status === 'ready' ? 'System model ready' :
           project.scan_status === 'failed' ? `Scan failed: ${project.scan_error ?? 'unknown error'}` :
           project.repo_url ? 'Repository connected — scan pending' : 'No repository connected'}
        </span>
      </div>
      <Link
        href={`/projects/${project.id}/system-model`}
        className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors flex-shrink-0"
      >
        View model →
      </Link>
    </div>
  )
}

export function ProjectDashboard({ project: initial, initialChanges }: { project: Project; initialChanges: Change[] }) {
  const router = useRouter()
  const [project, setProject] = useState(initial)
  const [changes, setChanges] = useState(initialChanges)

  useEffect(() => {
    if (project.scan_status !== 'scanning') return
    const id = setInterval(async () => {
      const res = await fetch(`/api/projects/${project.id}`)
      if (!res.ok) return
      const updated = await res.json()
      setProject(updated)
      if (updated.scan_status !== 'scanning') {
        clearInterval(id)
        router.refresh()
      }
    }, 3000)
    return () => clearInterval(id)
  }, [project.id, project.scan_status, router])

  return (
    <div className="flex flex-col h-screen bg-[#0b1326] text-on-surface overflow-hidden">
      <header className="w-full h-16 flex-shrink-0 flex items-center justify-between px-6 bg-[#0b1326] border-b border-white/5 z-50 font-headline antialiased tracking-tight">
        <div className="flex items-center gap-2 text-sm">
          <Link href="/projects" className="font-black text-indigo-400 tracking-tighter hover:text-indigo-300 transition-colors">
            FactoryOS
          </Link>
          <span className="text-slate-600">/</span>
          <span className="text-slate-200 font-medium truncate max-w-[240px]">{project.name}</span>
        </div>
        <div className="flex items-center gap-1">
          <button className="p-2 text-slate-400 hover:bg-[#171f33] rounded-lg transition-all" title="Settings">
            <span className="material-symbols-outlined text-[20px]">settings</span>
          </button>
          <div className="w-px h-5 bg-white/10 mx-1" />
          <ProfileAvatar />
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <LeftNav />
        <main className="flex-1 overflow-y-auto bg-[#0b1326] p-10">
          <div className="max-w-3xl mx-auto space-y-8">

            {/* Header */}
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs uppercase tracking-widest font-bold text-indigo-400 font-headline mb-1">Project</p>
                <h1 className="text-3xl font-extrabold font-headline tracking-tight text-on-surface">{project.name}</h1>
              </div>
              <Link
                href={`/projects/${project.id}/changes/new`}
                className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold bg-indigo-600 hover:bg-indigo-500 text-white transition-all active:scale-95 font-headline"
              >
                <span className="material-symbols-outlined text-[16px]">add</span>
                New Change
              </Link>
            </div>

            {/* Scan status */}
            <ScanStatusStrip project={project} />

            {/* Change list */}
            <div>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-bold text-slate-300 font-headline">Changes</h2>
                <span className="text-xs text-slate-500 font-mono">{changes.length} total</span>
              </div>

              {changes.length === 0 ? (
                <div className="rounded-xl p-12 text-center bg-[#131b2e] border border-white/5">
                  <span className="material-symbols-outlined text-slate-600 mb-3 block" style={{ fontSize: '32px' }}>change_history</span>
                  <p className="text-sm text-slate-500">No changes yet.</p>
                  <Link
                    href={`/projects/${project.id}/changes/new`}
                    className="inline-block mt-4 text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                  >
                    Submit your first change →
                  </Link>
                </div>
              ) : (
                <div className="space-y-2">
                  {changes.map(c => (
                    <Link
                      key={c.id}
                      href={`/projects/${project.id}/changes/${c.id}`}
                      className="flex items-center gap-4 px-5 py-4 rounded-xl bg-[#131b2e] border border-white/5 hover:border-white/10 hover:bg-[#171f33] transition-all"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-on-surface font-headline truncate">{c.title}</p>
                        <p className="text-xs text-slate-500 mt-0.5">{new Date(c.updated_at).toLocaleDateString('en-GB')}</p>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <Badge label={c.type} colorClass={TYPE_COLORS[c.type] ?? 'text-slate-400 bg-slate-400/10'} />
                        {c.risk_level && <Badge label={c.risk_level} colorClass={RISK_COLORS[c.risk_level] ?? 'text-slate-400 bg-slate-400/10'} />}
                        <Badge label={c.status.replace(/_/g, ' ')} colorClass={STATUS_COLORS[c.status] ?? 'text-slate-400 bg-slate-400/10'} />
                        <span className="material-symbols-outlined text-slate-600" style={{ fontSize: '16px' }}>chevron_right</span>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | grep -v "tests/" | head -10
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add app/projects/[id]/page.tsx app/projects/[id]/project-dashboard.tsx
git commit -m "feat: add project dashboard with scan status strip and change list"
```

---

### Task 8: Change intake form

**Files:**
- Create: `components/change/change-intake-form.tsx`
- Create: `app/projects/[id]/changes/new/page.tsx`

- [ ] **Step 1: Create `components/change/change-intake-form.tsx`**

```tsx
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'

const CHANGE_TYPES = ['bug', 'feature', 'refactor', 'hotfix'] as const
const PRIORITIES = ['low', 'medium', 'high'] as const

interface Props {
  projectId: string
}

export function ChangeIntakeForm({ projectId }: Props) {
  const router = useRouter()
  const [title, setTitle] = useState('')
  const [intent, setIntent] = useState('')
  const [type, setType] = useState<string>('feature')
  const [priority, setPriority] = useState<string>('medium')
  const [tagInput, setTagInput] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function addTag() {
    const tag = tagInput.trim().toLowerCase()
    if (tag && !tags.includes(tag)) setTags(prev => [...prev, tag])
    setTagInput('')
  }

  function removeTag(tag: string) {
    setTags(prev => prev.filter(t => t !== tag))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/change-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, title, intent, type, priority, tags }),
      })
      if (!res.ok) {
        const data = await res.json()
        setError(data.error ?? 'Failed to create change request')
        return
      }
      const change = await res.json()
      router.push(`/projects/${projectId}/changes/${change.id}`)
    } finally {
      setLoading(false)
    }
  }

  const inputClass = "w-full rounded-lg px-3 py-2 text-sm outline-none transition-all bg-[#131b2e] border border-white/10 text-slate-200 placeholder:text-slate-600 focus:border-indigo-500"
  const labelClass = "block text-xs font-bold uppercase tracking-widest text-slate-400 font-headline mb-1.5"

  return (
    <form onSubmit={handleSubmit} className="space-y-6 max-w-xl">
      <div>
        <label className={labelClass}>Title</label>
        <input
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="Short description of the change"
          required
          className={inputClass}
        />
      </div>

      <div>
        <label className={labelClass}>Intent</label>
        <textarea
          value={intent}
          onChange={e => setIntent(e.target.value)}
          placeholder="Describe what needs to change and why. Be specific — this drives the impact analysis."
          required
          rows={5}
          className={`${inputClass} resize-none`}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>Type</label>
          <select
            value={type}
            onChange={e => setType(e.target.value)}
            className={inputClass}
          >
            {CHANGE_TYPES.map(t => (
              <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass}>Priority</label>
          <select
            value={priority}
            onChange={e => setPriority(e.target.value)}
            className={inputClass}
          >
            {PRIORITIES.map(p => (
              <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className={labelClass}>Tags (optional)</label>
        <div className="flex gap-2">
          <input
            value={tagInput}
            onChange={e => setTagInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTag() } }}
            placeholder="Add tag and press Enter"
            className={`${inputClass} flex-1`}
          />
          <button
            type="button"
            onClick={addTag}
            className="px-3 py-2 rounded-lg text-xs font-semibold text-slate-400 hover:text-slate-200 border border-white/10 hover:border-white/20 transition-all"
          >
            Add
          </button>
        </div>
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-2">
            {tags.map(tag => (
              <span key={tag} className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-indigo-400/10 text-indigo-300 font-mono">
                {tag}
                <button type="button" onClick={() => removeTag(tag)} className="hover:text-white transition-colors">×</button>
              </span>
            ))}
          </div>
        )}
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <div className="flex items-center gap-3 pt-2">
        <Button type="submit" loading={loading}>Submit Change</Button>
        <button
          type="button"
          onClick={() => router.back()}
          className="text-sm text-slate-400 hover:text-slate-200 transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}
```

- [ ] **Step 2: Create `app/projects/[id]/changes/new/page.tsx`**

```tsx
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { LeftNav } from '@/components/app/left-nav'
import { ProfileAvatar } from '@/components/app/profile-avatar'
import { ChangeIntakeForm } from '@/components/change/change-intake-form'
import Link from 'next/link'

export default async function NewChangePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) redirect('/login')

  const { data: project } = await db
    .from('projects')
    .select('id, name')
    .eq('id', id)
    .eq('owner_id', user.id)
    .single()

  if (!project) redirect('/projects')

  return (
    <div className="flex flex-col h-screen bg-[#0b1326] text-on-surface overflow-hidden">
      <header className="w-full h-16 flex-shrink-0 flex items-center justify-between px-6 bg-[#0b1326] border-b border-white/5 z-50 font-headline antialiased tracking-tight">
        <div className="flex items-center gap-2 text-sm">
          <Link href="/projects" className="font-black text-indigo-400 tracking-tighter hover:text-indigo-300 transition-colors">
            FactoryOS
          </Link>
          <span className="text-slate-600">/</span>
          <Link href={`/projects/${project.id}`} className="text-slate-400 hover:text-slate-200 transition-colors font-medium truncate max-w-[180px]">
            {project.name}
          </Link>
          <span className="text-slate-600">/</span>
          <span className="text-slate-200 font-medium">New Change</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-px h-5 bg-white/10 mx-1" />
          <ProfileAvatar />
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <LeftNav />
        <main className="flex-1 overflow-y-auto bg-[#0b1326] p-10">
          <div className="max-w-3xl mx-auto">
            <div className="mb-8">
              <p className="text-xs uppercase tracking-widest font-bold text-indigo-400 font-headline mb-1">Change Request</p>
              <h1 className="text-3xl font-extrabold font-headline tracking-tight text-on-surface">Submit a Change</h1>
              <p className="text-sm text-slate-400 mt-2">Describe what you want to change. The system will map it to components and compute impact.</p>
            </div>
            <ChangeIntakeForm projectId={project.id} />
          </div>
        </main>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | grep -v "tests/" | head -10
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add components/change/change-intake-form.tsx app/projects/[id]/changes/new/page.tsx
git commit -m "feat: add change intake form and page"
```

---

### Task 9: Change detail page

**Files:**
- Create: `app/projects/[id]/changes/[changeId]/page.tsx`

Shows basic change info and analysis state. Full impact panel comes in Plan 4 (after the analysis engine exists).

- [ ] **Step 1: Create `app/projects/[id]/changes/[changeId]/page.tsx`**

```tsx
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ChangeDetailView } from './change-detail-view'

export default async function ChangeDetailPage({
  params,
}: {
  params: Promise<{ id: string; changeId: string }>
}) {
  const { id, changeId } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) redirect('/login')

  const { data: project } = await db
    .from('projects')
    .select('id, name')
    .eq('id', id)
    .eq('owner_id', user.id)
    .single()

  if (!project) redirect('/projects')

  const { data: change } = await db
    .from('change_requests')
    .select('id, project_id, title, intent, type, priority, status, risk_level, confidence_score, analysis_quality, tags, created_at, updated_at')
    .eq('id', changeId)
    .eq('project_id', id)
    .single()

  if (!change) redirect(`/projects/${id}`)

  return <ChangeDetailView project={project} change={change} />
}
```

- [ ] **Step 2: Create `app/projects/[id]/changes/[changeId]/change-detail-view.tsx`**

```tsx
'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { LeftNav } from '@/components/app/left-nav'
import { ProfileAvatar } from '@/components/app/profile-avatar'

interface Project { id: string; name: string }
interface Change {
  id: string
  project_id: string
  title: string
  intent: string
  type: string
  priority: string
  status: string
  risk_level: string | null
  confidence_score: number | null
  analysis_quality: string | null
  tags: string[]
  created_at: string
  updated_at: string
}

const TYPE_COLORS: Record<string, string> = {
  bug: 'text-red-400 bg-red-400/10',
  feature: 'text-indigo-400 bg-indigo-400/10',
  refactor: 'text-amber-400 bg-amber-400/10',
  hotfix: 'text-orange-400 bg-orange-400/10',
}
const RISK_COLORS: Record<string, string> = {
  low: 'text-green-400 bg-green-400/10',
  medium: 'text-amber-400 bg-amber-400/10',
  high: 'text-red-400 bg-red-400/10',
}

const ANALYZING_STATUSES = ['analyzing', 'analyzing_mapping', 'analyzing_propagation', 'analyzing_scoring']

const ANALYSIS_STEPS = [
  { label: 'Mapping intent → components', statuses: ['analyzing', 'analyzing_mapping'] },
  { label: 'Propagating dependency graph', statuses: ['analyzing_propagation'] },
  { label: 'Computing risk score', statuses: ['analyzing_scoring'] },
]

function Badge({ label, colorClass }: { label: string; colorClass: string }) {
  return (
    <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded font-mono ${colorClass}`}>
      {label}
    </span>
  )
}

export function ChangeDetailView({ project, change: initial }: { project: Project; change: Change }) {
  const router = useRouter()
  const [change, setChange] = useState(initial)
  const isAnalyzing = ANALYZING_STATUSES.includes(change.status)

  useEffect(() => {
    if (!isAnalyzing) return
    const id = setInterval(async () => {
      const res = await fetch(`/api/change-requests/${change.id}`)
      if (!res.ok) return
      const updated = await res.json()
      setChange(updated)
      if (!ANALYZING_STATUSES.includes(updated.status)) {
        clearInterval(id)
        router.refresh()
      }
    }, 2000)
    return () => clearInterval(id)
  }, [change.id, isAnalyzing, router])

  return (
    <div className="flex flex-col h-screen bg-[#0b1326] text-on-surface overflow-hidden">
      <header className="w-full h-16 flex-shrink-0 flex items-center justify-between px-6 bg-[#0b1326] border-b border-white/5 z-50 font-headline antialiased tracking-tight">
        <div className="flex items-center gap-2 text-sm">
          <Link href="/projects" className="font-black text-indigo-400 tracking-tighter hover:text-indigo-300 transition-colors">FactoryOS</Link>
          <span className="text-slate-600">/</span>
          <Link href={`/projects/${project.id}`} className="text-slate-400 hover:text-slate-200 transition-colors font-medium truncate max-w-[160px]">{project.name}</Link>
          <span className="text-slate-600">/</span>
          <span className="text-slate-200 font-medium truncate max-w-[200px]">{change.title}</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-px h-5 bg-white/10 mx-1" />
          <ProfileAvatar />
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <LeftNav />
        <main className="flex-1 overflow-y-auto bg-[#0b1326] p-10">
          <div className="max-w-3xl mx-auto space-y-8">

            {/* Header */}
            <div className="flex items-start gap-4 flex-wrap">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-2">
                  <Badge label={change.type} colorClass={TYPE_COLORS[change.type] ?? 'text-slate-400 bg-slate-400/10'} />
                  <Badge label={change.priority} colorClass="text-slate-400 bg-slate-400/10" />
                  {change.risk_level && <Badge label={`${change.risk_level} risk`} colorClass={RISK_COLORS[change.risk_level] ?? 'text-slate-400 bg-slate-400/10'} />}
                  {change.tags.map(tag => (
                    <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-400/10 text-indigo-300 font-mono">{tag}</span>
                  ))}
                </div>
                <h1 className="text-2xl font-extrabold font-headline tracking-tight text-on-surface">{change.title}</h1>
                <p className="text-xs text-slate-500 mt-1 font-mono">
                  Created {new Date(change.created_at).toLocaleDateString('en-GB')}
                </p>
              </div>
            </div>

            {/* Intent */}
            <div className="rounded-xl p-5 bg-[#131b2e] border border-white/5">
              <p className="text-xs font-bold uppercase tracking-widest text-slate-400 font-headline mb-2">Intent</p>
              <p className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap">{change.intent}</p>
            </div>

            {/* Analysis state */}
            {isAnalyzing ? (
              <div className="rounded-xl p-6 bg-[#131b2e] border border-white/5">
                <p className="text-xs font-bold uppercase tracking-widest text-slate-400 font-headline mb-4">Impact Analysis</p>
                <div className="space-y-3">
                  {ANALYSIS_STEPS.map((step, i) => {
                    const isActive = step.statuses.includes(change.status)
                    const isDone = ANALYSIS_STEPS.slice(0, i).some(s => !s.statuses.includes(change.status)) && !isActive
                    return (
                      <div key={step.label} className="flex items-center gap-3">
                        {isActive ? (
                          <span className="relative flex h-2 w-2 flex-shrink-0">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
                            <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-400" />
                          </span>
                        ) : isDone ? (
                          <span className="h-2 w-2 rounded-full bg-green-400 flex-shrink-0" />
                        ) : (
                          <span className="h-2 w-2 rounded-full bg-slate-700 flex-shrink-0" />
                        )}
                        <span className={`text-sm ${isActive ? 'text-slate-200' : isDone ? 'text-slate-500' : 'text-slate-600'}`}>
                          {step.label}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            ) : change.status === 'open' ? (
              <div className="rounded-xl p-6 bg-[#131b2e] border border-white/5 text-center">
                <span className="material-symbols-outlined text-slate-600 mb-2 block" style={{ fontSize: '28px' }}>analytics</span>
                <p className="text-sm text-slate-500">Impact analysis will run when triggered.</p>
                <p className="text-xs text-slate-600 mt-1">Analysis engine coming in a future update.</p>
              </div>
            ) : change.status === 'analyzed' ? (
              <div className="rounded-xl p-6 bg-[#131b2e] border border-white/5">
                <p className="text-xs font-bold uppercase tracking-widest text-slate-400 font-headline mb-2">Impact Analysis</p>
                <p className="text-sm text-slate-400">Analysis complete. Full impact panel coming in Plan 4.</p>
                {change.confidence_score !== null && (
                  <p className="text-xs text-slate-500 mt-1 font-mono">Confidence: {change.confidence_score}%</p>
                )}
              </div>
            ) : null}

          </div>
        </main>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | grep -v "tests/" | head -10
```

Expected: 0 errors.

- [ ] **Step 4: Run full test suite**

```bash
npm test 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/projects/[id]/changes/[changeId]/page.tsx app/projects/[id]/changes/[changeId]/change-detail-view.tsx
git commit -m "feat: add change detail page with analysis polling"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Covered by |
|---|---|
| `POST /api/projects` with repo_url, repo_token, scan_status | Task 2 |
| `GET /api/projects/[id]` with new columns | Task 2 |
| `GET /api/projects/[id]/system-model` | Task 3 |
| `POST /api/change-requests` | Task 5 |
| `GET /api/change-requests/[id]` with impact | Task 5 |
| `PATCH /api/change-requests/[id]` | Task 5 |
| Project dashboard with scan status + change list | Task 7 |
| Scan status polling every 3s | Task 7 |
| Change intake form (title, intent, type, priority, tags) | Task 8 |
| Change detail with analysis polling every 2s | Task 9 |
| Old routes/pages/library code removed | Task 1 |

**Not in this plan (correct):**
- `POST /api/projects/[id]/scan` — needs scanner (Plan 3)
- `POST /api/change-requests/[id]/adjust-scope` — needs analysis engine (Plan 4)
- `POST /api/change-requests/[id]/plan` — needs planning engine (Plan 5)
- Full impact panel — needs analysis data (Plan 4)
- System model browser — needs scanner (Plan 3)
