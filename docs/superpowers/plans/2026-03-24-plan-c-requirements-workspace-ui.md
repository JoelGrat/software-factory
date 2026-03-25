# Requirements Workspace UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the full Requirements Workspace UI — projects list, three-tab workspace (Input / Structured / Gaps & Questions), persistent Risk Summary Panel with Supabase Realtime, and all data API routes the UI needs.

**Architecture:** Server components fetch initial data; client components handle interactivity and Realtime subscriptions. All data mutations go through the existing API routes from Plans A/B plus eight new routes added here. Pure joining/sorting logic for the gaps endpoint is extracted into a testable helper. Plain Tailwind throughout — no component library — consistent with the existing auth pages.

**Tech Stack:** Next.js 14 App Router, TypeScript, Supabase (Postgres + Realtime), Vitest, Tailwind CSS

---

## File Map

**New API routes:**
- `app/api/projects/route.ts` — GET list user's projects, POST create project
- `app/api/projects/[id]/route.ts` — GET single project
- `app/api/requirements/route.ts` — POST create requirement for a project
- `app/api/requirements/[id]/route.ts` — GET requirement (id, title, raw_input, status), PATCH raw_input
- `app/api/requirements/[id]/items/route.ts` — GET structured items ordered by type
- `app/api/requirements/[id]/gaps/route.ts` — GET gaps with questions + tasks joined, sorted by priority
- `app/api/requirements/[id]/decisions/route.ts` — POST record decision → resolves linked gap → recalculates score
- `app/api/gaps/[id]/question/route.ts` — POST on-demand question generation for a gap

**New lib helpers:**
- `lib/requirements/gaps-with-details.ts` — pure function: join gaps + questions + tasks rows into `GapWithDetails[]`
- `lib/requirements/validate-decision.ts` — pure function: validate decision POST body (testable separately from the route)

**New pages:**
- `app/projects/page.tsx` — server component: list projects, inline create-project form
- `app/projects/[id]/requirements/page.tsx` — server component: auth check, load/create requirement, render workspace

**New components:**
- `components/ui/badge.tsx` — coloured badge (severity, category, role, status)
- `components/ui/button.tsx` — consistent button with variant + loading state
- `components/ui/spinner.tsx` — inline loading spinner
- `components/requirements/workspace.tsx` — client component: tabs + auto-navigate after analysis
- `components/requirements/risk-summary-panel.tsx` — client component: Realtime-subscribed summary bar
- `components/requirements/view-input.tsx` — client component: textarea + Analyze + pipeline progress
- `components/requirements/view-structured.tsx` — client component: items grouped by type
- `components/requirements/view-gaps.tsx` — client component: gap list, inline answer, Record Decision form

**New tests:**
- `tests/lib/requirements/gaps-with-details.test.ts` — unit tests for the joining/sorting helper
- `tests/api/requirements/decisions.test.ts` — unit tests for decision validation logic

---

## Task 1: `gaps-with-details` helper + tests

This pure function is used by `GET /api/requirements/[id]/gaps`. Extracting it keeps the route thin and makes it testable without Supabase.

**Files:**
- Create: `lib/requirements/gaps-with-details.ts`
- Create: `tests/lib/requirements/gaps-with-details.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/requirements/gaps-with-details.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { buildGapsWithDetails } from '@/lib/requirements/gaps-with-details'
import type { Gap, Question, InvestigationTask } from '@/lib/supabase/types'

const baseGap = (overrides: Partial<Gap> = {}): Gap => ({
  id: 'g1', requirement_id: 'r1', item_id: null,
  severity: 'critical', category: 'missing', description: 'desc',
  source: 'rule', rule_id: null, priority_score: 9,
  confidence: 100, question_generated: false, merged_into: null,
  resolved_at: null, resolution_source: null, created_at: '2026-01-01',
  ...overrides,
})

const baseQuestion = (overrides: Partial<Question> = {}): Question => ({
  id: 'q1', gap_id: 'g1', requirement_id: 'r1',
  question_text: 'Who approves?', target_role: 'ba',
  status: 'open', answer: null, answered_at: null, created_at: '2026-01-01',
  ...overrides,
})

const baseTask = (overrides: Partial<InvestigationTask> = {}): InvestigationTask => ({
  id: 't1', requirement_id: 'r1', linked_gap_id: 'g1',
  title: 'Investigate', description: 'desc',
  priority: 'high', status: 'open', created_at: '2026-01-01',
  ...overrides,
})

describe('buildGapsWithDetails', () => {
  it('attaches question and task to their gap', () => {
    const result = buildGapsWithDetails([baseGap()], [baseQuestion()], [baseTask()])
    expect(result[0].question?.id).toBe('q1')
    expect(result[0].task?.id).toBe('t1')
  })

  it('gap with no question or task gets null for both', () => {
    const result = buildGapsWithDetails([baseGap()], [], [])
    expect(result[0].question).toBeNull()
    expect(result[0].task).toBeNull()
  })

  it('counts how many gaps are merged into each survivor', () => {
    const survivor = baseGap({ id: 'g1' })
    const merged = baseGap({ id: 'g2', merged_into: 'g1' })
    const result = buildGapsWithDetails([survivor, merged], [], [])
    expect(result.find(g => g.id === 'g1')?.merged_count).toBe(1)
    expect(result.find(g => g.id === 'g2')?.merged_count).toBe(0)
  })

  it('sorts by priority_score descending', () => {
    const low = baseGap({ id: 'g1', priority_score: 2 })
    const high = baseGap({ id: 'g2', priority_score: 9 })
    const result = buildGapsWithDetails([low, high], [], [])
    expect(result[0].id).toBe('g2')
    expect(result[1].id).toBe('g1')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/lib/requirements/gaps-with-details.test.ts
```
Expected: FAIL — module not found

- [ ] **Step 3: Implement the helper**

Create `lib/requirements/gaps-with-details.ts`:
```typescript
import type { Gap, Question, InvestigationTask, GapSeverity, GapCategory, GapSource, TargetRole, QuestionStatus, TaskStatus } from '@/lib/supabase/types'

export interface GapWithDetails {
  id: string
  item_id: string | null
  severity: GapSeverity
  category: GapCategory
  description: string
  source: GapSource
  rule_id: string | null
  priority_score: number
  confidence: number
  question_generated: boolean
  merged_into: string | null
  resolved_at: string | null
  resolution_source: string | null
  question: {
    id: string
    question_text: string
    target_role: TargetRole
    status: QuestionStatus
    answer: string | null
  } | null
  task: {
    id: string
    title: string
    status: TaskStatus
    priority: 'high' | 'medium' | 'low'
  } | null
  merged_count: number
}

export function buildGapsWithDetails(
  gaps: Gap[],
  questions: Question[],
  tasks: InvestigationTask[]
): GapWithDetails[] {
  const questionByGapId = new Map(questions.map(q => [q.gap_id, q]))
  const taskByGapId = new Map(tasks.map(t => [t.linked_gap_id ?? '', t]))
  const mergedCountById = new Map<string, number>()

  for (const gap of gaps) {
    if (gap.merged_into) {
      mergedCountById.set(gap.merged_into, (mergedCountById.get(gap.merged_into) ?? 0) + 1)
    }
  }

  return [...gaps]
    .sort((a, b) => b.priority_score - a.priority_score)
    .map(gap => {
      const q = questionByGapId.get(gap.id)
      const t = taskByGapId.get(gap.id)
      return {
        id: gap.id,
        item_id: gap.item_id,
        severity: gap.severity,
        category: gap.category,
        description: gap.description,
        source: gap.source,
        rule_id: gap.rule_id,
        priority_score: gap.priority_score,
        confidence: gap.confidence,
        question_generated: gap.question_generated,
        merged_into: gap.merged_into,
        resolved_at: gap.resolved_at,
        resolution_source: gap.resolution_source,
        question: q ? { id: q.id, question_text: q.question_text, target_role: q.target_role, status: q.status, answer: q.answer } : null,
        task: t ? { id: t.id, title: t.title, status: t.status, priority: t.priority } : null,
        merged_count: mergedCountById.get(gap.id) ?? 0,
      }
    })
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/lib/requirements/gaps-with-details.test.ts
```
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add lib/requirements/gaps-with-details.ts tests/lib/requirements/gaps-with-details.test.ts
git commit -m "feat: add gaps-with-details helper (join + sort gaps with questions and tasks)"
```

---

## Task 2: Projects + Requirements CRUD routes

**Files:**
- Create: `app/api/projects/route.ts`
- Create: `app/api/projects/[id]/route.ts`
- Create: `app/api/requirements/route.ts`
- Create: `app/api/requirements/[id]/route.ts`

- [ ] **Step 1: Create projects list + create route**

Create `app/api/projects/route.ts`:
```typescript
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET() {
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: projects } = await db
    .from('projects')
    .select('id, name, created_at')
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

  const { data: project, error } = await db
    .from('projects')
    .insert({ name: body.name.trim(), owner_id: user.id })
    .select('id, name, created_at')
    .single()

  if (error) return NextResponse.json({ error: 'Failed to create project' }, { status: 500 })
  return NextResponse.json(project, { status: 201 })
}
```

- [ ] **Step 2: Create single project route**

Create `app/api/projects/[id]/route.ts`:
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
    .select('id, name, owner_id, created_at')
    .eq('id', id)
    .eq('owner_id', user.id)
    .single()

  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(project)
}
```

- [ ] **Step 3: Create requirement (POST)**

Create `app/api/requirements/route.ts`:
```typescript
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function POST(req: Request) {
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  if (!body.project_id || typeof body.project_id !== 'string') {
    return NextResponse.json({ error: 'project_id is required' }, { status: 400 })
  }

  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'Requirements'

  const { data: req_, error } = await db
    .from('requirements')
    .insert({
      project_id: body.project_id,
      title,
      raw_input: '',
      status: 'draft',
    })
    .select('id, project_id, title, raw_input, status, created_at, updated_at')
    .single()

  if (error) return NextResponse.json({ error: 'Failed to create requirement' }, { status: 500 })
  return NextResponse.json(req_, { status: 201 })
}
```

- [ ] **Step 4: Create requirement GET + PATCH route**

Create `app/api/requirements/[id]/route.ts`:
```typescript
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: req } = await db
    .from('requirements')
    .select('id, project_id, title, raw_input, status, blocked_reason, created_at, updated_at')
    .eq('id', id)
    .single()

  if (!req) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(req)
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  if (typeof body.raw_input !== 'string') {
    return NextResponse.json({ error: 'raw_input is required' }, { status: 400 })
  }

  const { error } = await db
    .from('requirements')
    .update({ raw_input: body.raw_input, updated_at: new Date().toISOString() })
    .eq('id', id)

  if (error) return NextResponse.json({ error: 'Failed to update' }, { status: 500 })
  return NextResponse.json({ ok: true })
}
```

- [ ] **Step 5: Commit**

```bash
git add app/api/projects/ app/api/requirements/route.ts app/api/requirements/\[id\]/route.ts
git commit -m "feat: add projects and requirements CRUD API routes"
```

---

## Task 3: Requirements data read routes

**Files:**
- Create: `app/api/requirements/[id]/items/route.ts`
- Create: `app/api/requirements/[id]/gaps/route.ts`

- [ ] **Step 1: Create items route**

Create `app/api/requirements/[id]/items/route.ts`:
```typescript
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: items } = await db
    .from('requirement_items')
    .select('*')
    .eq('requirement_id', id)
    .order('created_at', { ascending: true })

  return NextResponse.json(items ?? [])
}
```

- [ ] **Step 2: Create gaps route (with questions + tasks joined)**

Create `app/api/requirements/[id]/gaps/route.ts`:
```typescript
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { buildGapsWithDetails } from '@/lib/requirements/gaps-with-details'
import type { Gap, Question, InvestigationTask } from '@/lib/supabase/types'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const [{ data: gaps }, { data: questions }, { data: tasks }] = await Promise.all([
    db.from('gaps').select('*').eq('requirement_id', id),
    db.from('questions').select('*').eq('requirement_id', id),
    db.from('investigation_tasks').select('*').eq('requirement_id', id),
  ])

  const result = buildGapsWithDetails(
    (gaps ?? []) as Gap[],
    (questions ?? []) as Question[],
    (tasks ?? []) as InvestigationTask[]
  )

  return NextResponse.json(result)
}
```

- [ ] **Step 3: Commit**

```bash
git add app/api/requirements/\[id\]/items/route.ts app/api/requirements/\[id\]/gaps/route.ts
git commit -m "feat: add requirements items and gaps data routes"
```

---

## Task 4: Decisions route + on-demand question route

**Files:**
- Create: `app/api/requirements/[id]/decisions/route.ts`
- Create: `app/api/gaps/[id]/question/route.ts`
- Create: `tests/api/requirements/decisions.test.ts`

- [ ] **Step 1: Create `validate-decision` helper + write failing test**

Create `lib/requirements/validate-decision.ts`:
```typescript
export function validateDecision(body: unknown): string | null {
  if (!body || typeof body !== 'object') return 'Invalid body'
  const b = body as Record<string, unknown>
  if (!b.gap_id || typeof b.gap_id !== 'string') return 'gap_id is required'
  if (!b.decision || typeof b.decision !== 'string' || !(b.decision as string).trim()) return 'decision is required'
  if (!b.rationale || typeof b.rationale !== 'string' || !(b.rationale as string).trim()) return 'rationale is required'
  return null
}
```

Create `tests/api/requirements/decisions.test.ts`:
```typescript
import { describe, it, expect } from 'vitest'
import { validateDecision } from '@/lib/requirements/validate-decision'

describe('validateDecision', () => {
  it('returns null for valid input', () => {
    expect(validateDecision({ gap_id: 'g1', decision: 'We will use OAuth', rationale: 'Industry standard' })).toBeNull()
  })
  it('requires gap_id', () => {
    expect(validateDecision({ decision: 'x', rationale: 'y' })).toBe('gap_id is required')
  })
  it('requires decision', () => {
    expect(validateDecision({ gap_id: 'g1', rationale: 'y' })).toBe('decision is required')
  })
  it('requires rationale', () => {
    expect(validateDecision({ gap_id: 'g1', decision: 'x' })).toBe('rationale is required')
  })
  it('rejects whitespace-only decision', () => {
    expect(validateDecision({ gap_id: 'g1', decision: '   ', rationale: 'y' })).toBe('decision is required')
  })
  it('rejects whitespace-only rationale', () => {
    expect(validateDecision({ gap_id: 'g1', decision: 'x', rationale: '   ' })).toBe('rationale is required')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/api/requirements/decisions.test.ts
```
Expected: FAIL — `@/lib/requirements/validate-decision` module not found

- [ ] **Step 3: Run test again after creating the file to verify it passes**

```bash
npx vitest run tests/api/requirements/decisions.test.ts
```
Expected: 6 passed

- [ ] **Step 4: Create decisions route**

The extractor functions have these exact signatures (no AI parameter):
- `extractGapPattern(gap: Gap, projectId: string | null, db: SupabaseClient)`
- `extractResolutionPattern(gap: Gap, decision: DecisionLog, projectId: string | null, db: SupabaseClient)`

Create `app/api/requirements/[id]/decisions/route.ts`:
```typescript
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { computeScore } from '@/lib/requirements/scorer'
import { computeStatusFromScore } from '@/lib/requirements/re-evaluator'
import { validateDecision } from '@/lib/requirements/validate-decision'
import { extractGapPattern } from '@/lib/requirements/knowledge/pattern-extractor'
import { extractResolutionPattern } from '@/lib/requirements/knowledge/resolution-extractor'
import type { Gap, DecisionLog } from '@/lib/supabase/types'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const validationError = validateDecision(body)
  if (validationError) return NextResponse.json({ error: validationError }, { status: 400 })

  const { data: gap } = await db.from('gaps').select('*').eq('id', body.gap_id).single()
  if (!gap) return NextResponse.json({ error: 'Gap not found' }, { status: 404 })

  // Insert decision log entry
  const { data: decision, error: decisionError } = await db
    .from('decision_log')
    .insert({
      requirement_id: id,
      related_gap_id: body.gap_id,
      related_question_id: body.question_id ?? null,
      decision: body.decision.trim(),
      rationale: body.rationale.trim(),
      decided_by: user.id,
    })
    .select('id, requirement_id, related_gap_id, related_question_id, decision, rationale, decided_by, created_at')
    .single()

  if (decisionError || !decision) return NextResponse.json({ error: 'Failed to record decision' }, { status: 500 })

  // Resolve the gap
  await db.from('gaps').update({
    resolved_at: new Date().toISOString(),
    resolution_source: 'decision_recorded',
  }).eq('id', body.gap_id)

  // Recalculate score and status
  const [{ data: allGaps }, { data: allItems }, { data: currentReq }] = await Promise.all([
    db.from('gaps').select('*').eq('requirement_id', id),
    db.from('requirement_items').select('*').eq('requirement_id', id),
    db.from('requirements').select('status, project_id').eq('id', id).single(),
  ])

  const gapsForScoring = ((allGaps ?? []) as Gap[]).map(g => ({
    item_id: g.item_id, severity: g.severity, category: g.category,
    description: g.description, source: g.source, rule_id: g.rule_id,
    priority_score: g.priority_score, confidence: g.confidence, question_generated: g.question_generated,
  }))

  const score = computeScore(gapsForScoring, new Set(), allItems ?? [])
  await db.from('completeness_scores').insert({
    requirement_id: id,
    overall_score: score.overall_score, completeness: score.completeness,
    nfr_score: score.nfr_score, confidence: score.confidence,
    breakdown: score.breakdown, scored_at: new Date().toISOString(),
  })

  const newStatus = computeStatusFromScore(allGaps ?? [])
  if (currentReq?.status !== 'blocked') {
    await db.from('requirements').update({ status: newStatus, updated_at: new Date().toISOString() }).eq('id', id)
  }

  await db.from('audit_log').insert({
    entity_type: 'decision_log', entity_id: decision.id,
    action: 'created', actor_id: user.id,
    diff: { gap_id: body.gap_id, decision_id: decision.id },
  })

  // Async knowledge extraction — fire-and-forget, correct signatures
  const projectId = currentReq?.project_id ?? null
  void extractGapPattern(gap as Gap, projectId, db)
  void extractResolutionPattern(gap as Gap, decision as DecisionLog, projectId, db)

  return NextResponse.json({ decision_id: decision.id, new_status: newStatus }, { status: 201 })
}
```

- [ ] **Step 6: Create on-demand question route**

Create `app/api/gaps/[id]/question/route.ts`:
```typescript
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getProvider } from '@/lib/ai/registry'
import { parseStructuredResponse } from '@/lib/ai/provider'
import { buildGenerateQuestionPrompt, GENERATE_QUESTION_SCHEMA } from '@/lib/ai/prompts/generate-question'
import type { TargetRole } from '@/lib/supabase/types'

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: gap } = await db.from('gaps').select('*').eq('id', id).single()
  if (!gap) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (gap.question_generated) {
    return NextResponse.json({ error: 'Question already generated for this gap' }, { status: 409 })
  }

  const ai = getProvider()
  const prompt = buildGenerateQuestionPrompt(gap.description, gap.category, null)
  const raw = await ai.complete(prompt, { responseSchema: GENERATE_QUESTION_SCHEMA })
  const parsed = parseStructuredResponse<{ question_text: string; target_role: TargetRole }>(raw, GENERATE_QUESTION_SCHEMA)

  const { data: question, error } = await db
    .from('questions')
    .insert({
      gap_id: id,
      requirement_id: gap.requirement_id,
      question_text: parsed.question_text,
      target_role: parsed.target_role,
      status: 'open',
    })
    .select('*')
    .single()

  if (error) return NextResponse.json({ error: 'Failed to save question' }, { status: 500 })

  await db.from('gaps').update({ question_generated: true }).eq('id', id)

  return NextResponse.json(question, { status: 201 })
}
```

- [ ] **Step 7: Commit**

```bash
git add lib/requirements/validate-decision.ts tests/api/requirements/decisions.test.ts app/api/requirements/\[id\]/decisions/ app/api/gaps/
git commit -m "feat: add validate-decision helper, decisions route, and on-demand question generation route"
```

---

## Task 5: Shared UI primitives

**Files:**
- Create: `components/ui/badge.tsx`
- Create: `components/ui/button.tsx`
- Create: `components/ui/spinner.tsx`

These are pure Tailwind components — no tests needed (visual primitives, not logic).

- [ ] **Step 1: Create Badge**

Create `components/ui/badge.tsx`:
```typescript
import type { GapSeverity, GapCategory, GapSource, TargetRole, QuestionStatus, TaskStatus } from '@/lib/supabase/types'

type BadgeVariant = GapSeverity | GapCategory | GapSource | TargetRole | QuestionStatus | TaskStatus | 'draft' | 'analyzing' | 'incomplete' | 'review_required' | 'ready_for_dev' | 'blocked'

const VARIANT_CLASSES: Record<string, string> = {
  // severity
  critical: 'bg-red-100 text-red-800',
  major: 'bg-orange-100 text-orange-800',
  minor: 'bg-yellow-100 text-yellow-800',
  // category
  missing: 'bg-red-50 text-red-700',
  ambiguous: 'bg-purple-100 text-purple-800',
  conflicting: 'bg-orange-50 text-orange-700',
  incomplete: 'bg-yellow-50 text-yellow-700',
  // source
  rule: 'bg-gray-100 text-gray-700',
  ai: 'bg-blue-100 text-blue-700',
  pattern: 'bg-indigo-100 text-indigo-700',
  // target role
  ba: 'bg-teal-100 text-teal-800',
  architect: 'bg-violet-100 text-violet-800',
  po: 'bg-sky-100 text-sky-800',
  dev: 'bg-slate-100 text-slate-800',
  // question status
  open: 'bg-blue-50 text-blue-700',
  answered: 'bg-green-100 text-green-800',
  dismissed: 'bg-gray-100 text-gray-500',
  // task status
  'in-progress': 'bg-blue-100 text-blue-800',
  resolved: 'bg-green-100 text-green-700',
  // requirement status
  draft: 'bg-gray-100 text-gray-600',
  analyzing: 'bg-blue-100 text-blue-700',
  review_required: 'bg-yellow-100 text-yellow-800',
  ready_for_dev: 'bg-green-100 text-green-800',
  blocked: 'bg-red-200 text-red-900',
}

const LABELS: Record<string, string> = {
  ba: 'BA', po: 'PO', dev: 'Dev', architect: 'Architect',
  review_required: 'Review Required', ready_for_dev: 'Ready for Dev',
  'in-progress': 'In Progress',
}

interface BadgeProps {
  variant: BadgeVariant | string
  label?: string
  className?: string
}

export function Badge({ variant, label, className = '' }: BadgeProps) {
  const cls = VARIANT_CLASSES[variant] ?? 'bg-gray-100 text-gray-700'
  const text = label ?? LABELS[variant] ?? variant
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${cls} ${className}`}>
      {text}
    </span>
  )
}
```

- [ ] **Step 2: Create Button**

Create `components/ui/button.tsx`:
```typescript
interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
  loading?: boolean
}

const VARIANT_CLASSES = {
  primary: 'bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50',
  secondary: 'bg-gray-100 text-gray-800 hover:bg-gray-200 disabled:opacity-50',
  danger: 'bg-red-600 text-white hover:bg-red-700 disabled:opacity-50',
  ghost: 'bg-transparent text-gray-600 hover:bg-gray-100 disabled:opacity-50',
}

export function Button({ variant = 'primary', loading = false, disabled, children, className = '', ...props }: ButtonProps) {
  return (
    <button
      disabled={disabled || loading}
      className={`inline-flex items-center gap-2 px-4 py-2 rounded text-sm font-medium transition-colors ${VARIANT_CLASSES[variant]} ${className}`}
      {...props}
    >
      {loading && (
        <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
        </svg>
      )}
      {children}
    </button>
  )
}
```

- [ ] **Step 3: Create Spinner**

Create `components/ui/spinner.tsx`:
```typescript
export function Spinner({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const sz = { sm: 'h-4 w-4', md: 'h-6 w-6', lg: 'h-8 w-8' }[size]
  return (
    <svg className={`animate-spin ${sz} text-blue-600`} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
    </svg>
  )
}
```

- [ ] **Step 4: Commit**

```bash
git add components/ui/
git commit -m "feat: add Badge, Button, Spinner UI primitives"
```

---

## Task 6: Projects page

**Files:**
- Create: `app/projects/page.tsx`
- Create: `components/projects/create-project-form.tsx`

- [ ] **Step 1: Create the client create-project form**

Create `components/projects/create-project-form.tsx`:
```typescript
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'

export function CreateProjectForm() {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()

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
      router.push(`/projects/${project.id}/requirements`)
    } finally {
      setLoading(false)
    }
  }

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)}>+ New Project</Button>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-3 mt-4">
      <input
        autoFocus
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder="Project name"
        required
        className="border rounded px-3 py-2 text-sm w-64"
      />
      <Button type="submit" loading={loading}>Create</Button>
      <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      {error && <p className="text-red-600 text-sm">{error}</p>}
    </form>
  )
}
```

- [ ] **Step 2: Create the projects page**

Create `app/projects/page.tsx`:
```typescript
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { CreateProjectForm } from '@/components/projects/create-project-form'

export default async function ProjectsPage() {
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) redirect('/login')

  const { data: projects } = await db
    .from('projects')
    .select('id, name, created_at')
    .eq('owner_id', user.id)
    .order('created_at', { ascending: false })

  return (
    <main className="max-w-2xl mx-auto py-12 px-4">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold">Projects</h1>
        <CreateProjectForm />
      </div>
      {!projects?.length ? (
        <p className="text-gray-500">No projects yet. Create one to get started.</p>
      ) : (
        <ul className="divide-y border rounded-lg">
          {projects.map(p => (
            <li key={p.id}>
              <Link
                href={`/projects/${p.id}/requirements`}
                className="flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors"
              >
                <span className="font-medium">{p.name}</span>
                <span className="text-xs text-gray-400">
                  {new Date(p.created_at).toLocaleDateString()}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add app/projects/page.tsx components/projects/
git commit -m "feat: add projects list page with create project form"
```

---

## Task 7: Risk Summary Panel

The panel subscribes to two Supabase Realtime channels: `completeness_scores` (INSERT) and `requirements` (UPDATE), both filtered to the current requirement. On any change it re-fetches the summary from `/api/requirements/[id]/summary`.

**Files:**
- Create: `components/requirements/risk-summary-panel.tsx`

- [ ] **Step 1: Create the panel**

Create `components/requirements/risk-summary-panel.tsx`:
```typescript
'use client'
import { useEffect, useState, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { RequirementSummary } from '@/lib/supabase/types'
import { Spinner } from '@/components/ui/spinner'

const STATUS_CONFIG = {
  draft:            { icon: '📝', label: 'DRAFT',                     cls: 'border-gray-200 bg-gray-50' },
  analyzing:        { icon: '⏳', label: 'ANALYZING…',                cls: 'border-blue-200 bg-blue-50' },
  incomplete:       { icon: '⛔', label: 'NOT READY FOR DEVELOPMENT', cls: 'border-red-300 bg-red-50' },
  review_required:  { icon: '⚠️',  label: 'REVIEW REQUIRED',           cls: 'border-yellow-300 bg-yellow-50' },
  ready_for_dev:    { icon: '✅', label: 'READY FOR DEVELOPMENT',     cls: 'border-green-300 bg-green-50' },
  blocked:          { icon: '🔒', label: 'BLOCKED',                   cls: 'border-red-400 bg-red-100' },
}

interface Props {
  requirementId: string
  initialSummary: RequirementSummary
  onCriticalClick?: () => void
  onMajorClick?: () => void
  onScoreClick?: () => void
}

export function RiskSummaryPanel({ requirementId, initialSummary, onCriticalClick, onMajorClick, onScoreClick }: Props) {
  const [summary, setSummary] = useState<RequirementSummary>(initialSummary)

  const refresh = useCallback(async () => {
    const res = await fetch(`/api/requirements/${requirementId}/summary`)
    if (res.ok) setSummary(await res.json())
  }, [requirementId])

  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel(`req-summary-${requirementId}`)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'completeness_scores',
        filter: `requirement_id=eq.${requirementId}`,
      }, () => void refresh())
      .on('postgres_changes', {
        event: 'UPDATE', schema: 'public', table: 'requirements',
        filter: `id=eq.${requirementId}`,
      }, () => void refresh())
      .subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [requirementId, refresh])

  const cfg = STATUS_CONFIG[summary.status] ?? STATUS_CONFIG.draft
  const isAnalyzing = summary.status === 'analyzing'

  return (
    <div className={`border rounded-lg px-4 py-3 mb-6 flex flex-wrap items-center gap-x-6 gap-y-2 ${cfg.cls}`}>
      {isAnalyzing && <Spinner size="sm" />}
      <span className="font-semibold text-sm">{cfg.icon} {summary.status === 'blocked' ? `${cfg.label} — ${summary.blocked_reason ?? ''}` : cfg.label}</span>

      {!isAnalyzing && summary.status !== 'draft' && (
        <>
          <button
            onClick={onCriticalClick}
            className="text-sm text-red-700 hover:underline font-medium"
          >
            🔴 {summary.critical_count} critical
          </button>
          <button
            onClick={onMajorClick}
            className="text-sm text-orange-700 hover:underline font-medium"
          >
            ⚠️ {summary.major_count} major
          </button>
          <button
            onClick={onScoreClick}
            className="text-sm text-gray-700 hover:underline"
          >
            📉 {summary.overall_score}% overall
          </button>
          <span className="text-sm text-gray-500">
            Confidence: {summary.confidence}%
          </span>
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add components/requirements/risk-summary-panel.tsx
git commit -m "feat: add RiskSummaryPanel with Supabase Realtime subscription"
```

---

## Task 8: View 1 — Input

The Input view manages the raw text textarea and the Analyze button. When Analyze is clicked, it:
1. PATCHes the raw_input to save current text
2. Subscribes to `audit_log` inserts for this requirement (for step progress)
3. POSTs to `/api/requirements/[id]/analyze`
4. Calls `onAnalysisComplete` when done so the workspace switches to View 2

**Files:**
- Create: `components/requirements/view-input.tsx`

- [ ] **Step 1: Create the view**

Create `components/requirements/view-input.tsx`:
```typescript
'use client'
import { useState, useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'

const STEP_LABELS: Record<string, string> = {
  parse:     '✓ Requirements parsed',
  gaps:      '✓ Gaps detected',
  questions: '✓ Questions generated',
  tasks:     '✓ Investigation tasks created',
}

interface Props {
  requirementId: string
  initialRawInput: string
  onAnalysisComplete: () => void
}

export function ViewInput({ requirementId, initialRawInput, onAnalysisComplete }: Props) {
  const [text, setText] = useState(initialRawInput)
  const [analyzing, setAnalyzing] = useState(false)
  const [completedSteps, setCompletedSteps] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const channelRef = useRef<ReturnType<ReturnType<typeof createClient>['channel']> | null>(null)

  function subscribeToProgress() {
    const supabase = createClient()
    const channel = supabase
      .channel(`pipeline-${requirementId}`)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'audit_log',
        filter: `entity_id=eq.${requirementId}`,
      }, (payload) => {
        const diff = payload.new?.diff as Record<string, unknown> | undefined
        if (diff?.step && typeof diff.step === 'string') {
          setCompletedSteps(prev => prev.includes(diff.step as string) ? prev : [...prev, diff.step as string])
        }
      })
      .subscribe()
    channelRef.current = channel
    return () => { void supabase.removeChannel(channel) }
  }

  async function handleAnalyze() {
    if (!text.trim()) return
    setError(null)
    setCompletedSteps([])
    setAnalyzing(true)

    // Save raw_input first
    await fetch(`/api/requirements/${requirementId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw_input: text }),
    })

    // Subscribe to progress events
    const unsubscribe = subscribeToProgress()

    try {
      const res = await fetch(`/api/requirements/${requirementId}/analyze`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok || !data.success) {
        setError(data.error ?? 'Analysis failed')
        return
      }
      onAnalysisComplete()
    } catch (err) {
      setError(String(err))
    } finally {
      unsubscribe()
      setAnalyzing(false)
    }
  }

  return (
    <div className="space-y-4">
      <textarea
        value={text}
        onChange={e => setText(e.target.value)}
        disabled={analyzing}
        placeholder="Paste your requirements here — plain text, bullet points, user stories, or meeting notes..."
        className="w-full h-64 border rounded-lg px-3 py-2 font-mono text-sm resize-y focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-60"
      />

      <div className="flex items-start gap-6">
        <Button
          onClick={handleAnalyze}
          loading={analyzing}
          disabled={!text.trim() || analyzing}
        >
          {analyzing ? 'Analyzing…' : 'Analyze Requirements'}
        </Button>

        {analyzing && completedSteps.length > 0 && (
          <ul className="text-sm space-y-1">
            {completedSteps.map(step => (
              <li key={step} className="text-green-700">{STEP_LABELS[step] ?? `✓ ${step}`}</li>
            ))}
            <li className="text-blue-600 animate-pulse">Processing…</li>
          </ul>
        )}
      </div>

      {error && (
        <div className="border border-red-300 bg-red-50 rounded p-3 text-red-700 text-sm">
          {error}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add components/requirements/view-input.tsx
git commit -m "feat: add ViewInput with analyze trigger and realtime pipeline step progress"
```

---

## Task 9: View 2 — Structured Items

Items are grouped by type: functional → non-functional → constraint → assumption. Each item shows its title, description, source_text, and any gap severity badges.

**Files:**
- Create: `components/requirements/view-structured.tsx`

- [ ] **Step 1: Create the view**

Create `components/requirements/view-structured.tsx`:
```typescript
'use client'
import { useState } from 'react'
import type { RequirementItem, Gap, RequirementStatus } from '@/lib/supabase/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

const TYPE_ORDER: RequirementItem['type'][] = ['functional', 'non-functional', 'constraint', 'assumption']
const TYPE_LABELS: Record<RequirementItem['type'], string> = {
  functional: 'Functional Requirements',
  'non-functional': 'Non-Functional Requirements',
  constraint: 'Constraints',
  assumption: 'Assumptions',
}

interface Props {
  items: RequirementItem[]
  gaps: Array<{ id: string; item_id: string | null; severity: string; resolved_at: string | null; merged_into: string | null }>
  status: RequirementStatus
  blockedGapDescriptions: string[]
  requirementId: string
  onMarkReady: () => Promise<void>
  onViewGap?: () => void
}

export function ViewStructured({ items, gaps, status, blockedGapDescriptions, requirementId, onMarkReady, onViewGap }: Props) {
  const [marking, setMarking] = useState(false)
  const [markError, setMarkError] = useState<string | null>(null)

  const activeGapsByItemId = new Map<string, typeof gaps[number][]>()
  for (const gap of gaps) {
    if (!gap.resolved_at && !gap.merged_into && gap.item_id) {
      const list = activeGapsByItemId.get(gap.item_id) ?? []
      list.push(gap)
      activeGapsByItemId.set(gap.item_id, list)
    }
  }

  const grouped = TYPE_ORDER.map(type => ({
    type,
    items: items.filter(i => i.type === type),
  })).filter(g => g.items.length > 0)

  const canMarkReady = status === 'review_required' || status === 'ready_for_dev'
  const isReady = status === 'ready_for_dev'

  async function handleMarkReady() {
    setMarking(true)
    setMarkError(null)
    try {
      await onMarkReady()
    } catch (err) {
      setMarkError(String(err))
    } finally {
      setMarking(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <p className="text-sm text-gray-500">{items.length} requirement item{items.length !== 1 ? 's' : ''} extracted</p>
        <div className="text-right">
          {!canMarkReady && blockedGapDescriptions.length > 0 && (
            <div className="mb-2 text-xs text-red-600 max-w-xs">
              Blocked by {blockedGapDescriptions.length} critical gap{blockedGapDescriptions.length > 1 ? 's' : ''}.{' '}
              <button onClick={onViewGap} className="underline">View gaps</button>
            </div>
          )}
          <Button
            variant={isReady ? 'secondary' : 'primary'}
            disabled={!canMarkReady || marking}
            loading={marking}
            onClick={handleMarkReady}
          >
            {isReady ? '✓ Ready for Development' : 'Mark Ready for Dev'}
          </Button>
          {markError && <p className="text-red-600 text-xs mt-1">{markError}</p>}
        </div>
      </div>

      {grouped.map(({ type, items: typeItems }) => (
        <section key={type}>
          <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">
            {TYPE_LABELS[type]} ({typeItems.length})
          </h3>
          <ul className="space-y-2">
            {typeItems.map(item => {
              const itemGaps = activeGapsByItemId.get(item.id) ?? []
              return (
                <li key={item.id} className="border rounded-lg p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className="font-medium text-sm">{item.title}</span>
                        <Badge variant={item.priority} label={item.priority} />
                        {item.nfr_category && <Badge variant={item.nfr_category} />}
                      </div>
                      <p className="text-sm text-gray-600">{item.description}</p>
                      {item.source_text && (
                        <p className="text-xs text-gray-400 mt-1 italic">"{item.source_text}"</p>
                      )}
                    </div>
                    {itemGaps.length > 0 && (
                      <div className="flex flex-wrap gap-1 shrink-0">
                        {itemGaps.map(gap => (
                          <Badge key={gap.id} variant={gap.severity as 'critical' | 'major' | 'minor'} />
                        ))}
                      </div>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      ))}

      {items.length === 0 && (
        <p className="text-gray-400 text-center py-8">No structured items yet. Run analysis first.</p>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add components/requirements/view-structured.tsx
git commit -m "feat: add ViewStructured - items grouped by type with gap badges"
```

---

## Task 10: View 3 — Gaps & Questions

This is the most complex view. It shows top-10 gaps with questions by default, with a "Show all" toggle. Each gap with a question expands inline to:
- Show the question, target role badge, and linked task status
- An answer textarea with a "Save Answer" button
- A "Record Decision" button that opens a two-field form (decision + rationale)
- Gaps without questions show a "Generate question" button

**Files:**
- Create: `components/requirements/view-gaps.tsx`

- [ ] **Step 1: Create the view**

Create `components/requirements/view-gaps.tsx`:
```typescript
'use client'
import { useState } from 'react'
import type { GapWithDetails } from '@/lib/requirements/gaps-with-details'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'

interface DecisionForm {
  decision: string
  rationale: string
}

interface Props {
  requirementId: string
  gaps: GapWithDetails[]
  onUpdate: () => void   // called after any mutation to trigger parent re-fetch
}

export function ViewGaps({ requirementId, gaps, onUpdate }: Props) {
  const [showAll, setShowAll] = useState(false)
  const [expandedGapId, setExpandedGapId] = useState<string | null>(null)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [savingAnswer, setSavingAnswer] = useState<string | null>(null)
  const [showDecision, setShowDecision] = useState<string | null>(null)
  const [decisionForms, setDecisionForms] = useState<Record<string, DecisionForm>>({})
  const [savingDecision, setSavingDecision] = useState<string | null>(null)
  const [generatingQuestion, setGeneratingQuestion] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  // gaps arrive pre-sorted by priority_score desc from buildGapsWithDetails
  const allNonMerged = gaps.filter(g => !g.merged_into)
  const topGaps = allNonMerged.slice(0, 10)   // top 10 by priority regardless of question presence
  const displayedGaps = showAll ? allNonMerged : topGaps

  async function saveAnswer(gap: GapWithDetails) {
    if (!gap.question) return
    const answer = answers[gap.id]?.trim()
    if (!answer) return
    setSavingAnswer(gap.id)
    setErrors(prev => ({ ...prev, [gap.id]: '' }))
    try {
      const res = await fetch(`/api/questions/${gap.question.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer }),
      })
      if (!res.ok) {
        const d = await res.json()
        setErrors(prev => ({ ...prev, [gap.id]: d.error ?? 'Failed to save answer' }))
        return
      }
      onUpdate()
    } finally {
      setSavingAnswer(null)
    }
  }

  async function saveDecision(gap: GapWithDetails) {
    const form = decisionForms[gap.id]
    if (!form?.decision?.trim() || !form?.rationale?.trim()) {
      setErrors(prev => ({ ...prev, [gap.id]: 'Both decision and rationale are required' }))
      return
    }
    setSavingDecision(gap.id)
    setErrors(prev => ({ ...prev, [gap.id]: '' }))
    try {
      const res = await fetch(`/api/requirements/${requirementId}/decisions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gap_id: gap.id,
          question_id: gap.question?.id ?? null,
          decision: form.decision.trim(),
          rationale: form.rationale.trim(),
        }),
      })
      if (!res.ok) {
        const d = await res.json()
        setErrors(prev => ({ ...prev, [gap.id]: d.error ?? 'Failed to record decision' }))
        return
      }
      setShowDecision(null)
      onUpdate()
    } finally {
      setSavingDecision(null)
    }
  }

  async function generateQuestion(gap: GapWithDetails) {
    setGeneratingQuestion(gap.id)
    setErrors(prev => ({ ...prev, [gap.id]: '' }))
    try {
      const res = await fetch(`/api/gaps/${gap.id}/question`, { method: 'POST' })
      if (!res.ok) {
        const d = await res.json()
        setErrors(prev => ({ ...prev, [gap.id]: d.error ?? 'Failed to generate question' }))
        return
      }
      onUpdate()
    } finally {
      setGeneratingQuestion(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">
          Showing {topGaps.length} of {allNonMerged.length} gap{allNonMerged.length !== 1 ? 's' : ''}
        </p>
        {allNonMerged.length > 10 && (
          <button
            onClick={() => setShowAll(v => !v)}
            className="text-sm text-blue-600 hover:underline"
          >
            {showAll ? 'Show top 10 only' : `Show all ${allNonMerged.length} gaps`}
          </button>
        )}
      </div>

      {displayedGaps.map(gap => (
        <div
          key={gap.id}
          className={`border rounded-lg overflow-hidden ${gap.resolved_at ? 'opacity-60' : ''}`}
        >
          {/* Gap header */}
          <div
            className="flex items-start justify-between gap-3 p-4 cursor-pointer hover:bg-gray-50"
            onClick={() => setExpandedGapId(expandedGapId === gap.id ? null : gap.id)}
          >
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <Badge variant={gap.severity} />
                <Badge variant={gap.category} />
                <Badge variant={gap.source} />
                {gap.merged_count > 0 && (
                  <span className="text-xs text-gray-400">+{gap.merged_count} similar</span>
                )}
                {gap.resolved_at && <Badge variant="answered" label="Resolved" />}
              </div>
              <p className="text-sm text-gray-800">{gap.description}</p>
              {gap.source === 'pattern' && (
                <p className="text-xs text-indigo-600 mt-1">Seen in previous requirements</p>
              )}
            </div>
            <span className="text-gray-400 text-sm shrink-0">{expandedGapId === gap.id ? '▲' : '▼'}</span>
          </div>

          {/* Expanded body */}
          {expandedGapId === gap.id && !gap.resolved_at && (
            <div className="border-t px-4 py-4 space-y-4 bg-gray-50">
              {/* Task status */}
              {gap.task && (
                <div className="flex items-center gap-2 text-sm">
                  <span className="text-gray-500">Task:</span>
                  <span className="font-medium">{gap.task.title}</span>
                  <Badge variant={gap.task.status} />
                </div>
              )}

              {/* Question */}
              {gap.question ? (
                <div className="space-y-3">
                  <div className="flex items-start gap-2">
                    <Badge variant={gap.question.target_role} />
                    <p className="text-sm font-medium">{gap.question.question_text}</p>
                  </div>

                  {gap.question.status === 'answered' ? (
                    <p className="text-sm text-green-700 bg-green-50 rounded p-2">
                      ✓ Answered: {gap.question.answer}
                    </p>
                  ) : (
                    <>
                      <textarea
                        value={answers[gap.id] ?? ''}
                        onChange={e => setAnswers(prev => ({ ...prev, [gap.id]: e.target.value }))}
                        placeholder="Type the stakeholder's answer here…"
                        rows={3}
                        className="w-full border rounded px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                      <div className="flex items-center gap-3">
                        <Button
                          variant="secondary"
                          loading={savingAnswer === gap.id}
                          disabled={!answers[gap.id]?.trim()}
                          onClick={() => saveAnswer(gap)}
                        >
                          Save Answer
                        </Button>
                        <button
                          onClick={() => setShowDecision(showDecision === gap.id ? null : gap.id)}
                          className="text-sm text-blue-600 hover:underline"
                        >
                          Record Decision instead
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <span className="text-sm text-gray-500">No question generated for this gap.</span>
                  <Button
                    variant="ghost"
                    loading={generatingQuestion === gap.id}
                    onClick={() => generateQuestion(gap)}
                  >
                    Generate question
                  </Button>
                </div>
              )}

              {/* Record Decision form */}
              {(showDecision === gap.id || !gap.question) && showDecision === gap.id && (
                <div className="border rounded-lg p-4 bg-white space-y-3">
                  <h4 className="text-sm font-semibold">Record Decision</h4>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Decision *</label>
                    <textarea
                      rows={2}
                      value={decisionForms[gap.id]?.decision ?? ''}
                      onChange={e => setDecisionForms(prev => ({
                        ...prev,
                        [gap.id]: { ...prev[gap.id], decision: e.target.value },
                      }))}
                      placeholder="What was decided?"
                      className="w-full border rounded px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Rationale *</label>
                    <textarea
                      rows={2}
                      value={decisionForms[gap.id]?.rationale ?? ''}
                      onChange={e => setDecisionForms(prev => ({
                        ...prev,
                        [gap.id]: { ...prev[gap.id], rationale: e.target.value },
                      }))}
                      placeholder="Why was this decided? What constraints or context informed it?"
                      className="w-full border rounded px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div className="flex items-center gap-3">
                    <Button
                      loading={savingDecision === gap.id}
                      onClick={() => saveDecision(gap)}
                    >
                      Save Decision
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => setShowDecision(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}

              {errors[gap.id] && (
                <p className="text-red-600 text-sm">{errors[gap.id]}</p>
              )}
            </div>
          )}
        </div>
      ))}

      {displayedGaps.length === 0 && (
        <p className="text-gray-400 text-center py-8">No gaps detected. Analysis not yet run or requirements are complete.</p>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add components/requirements/view-gaps.tsx
git commit -m "feat: add ViewGaps with inline answer, record decision, and on-demand question generation"
```

---

## Task 11: Workspace component + requirements page

The workspace is a client component that owns the active tab state and wires the three views together. The requirements page is a server component that loads initial data and creates the requirement if none exists.

**Files:**
- Create: `components/requirements/workspace.tsx`
- Create: `app/projects/[id]/requirements/page.tsx`

- [ ] **Step 1: Create the workspace client component**

Create `components/requirements/workspace.tsx`:
```typescript
'use client'
import { useState, useCallback } from 'react'
import type { RequirementItem, Gap, RequirementStatus } from '@/lib/supabase/types'
import type { GapWithDetails } from '@/lib/requirements/gaps-with-details'
import type { RequirementSummary } from '@/lib/supabase/types'
import { RiskSummaryPanel } from '@/components/requirements/risk-summary-panel'
import { ViewInput } from '@/components/requirements/view-input'
import { ViewStructured } from '@/components/requirements/view-structured'
import { ViewGaps } from '@/components/requirements/view-gaps'

type Tab = 'input' | 'structured' | 'gaps'

interface Props {
  requirementId: string
  initialRawInput: string
  initialItems: RequirementItem[]
  initialGaps: GapWithDetails[]
  initialSummary: RequirementSummary
}

export function Workspace({ requirementId, initialRawInput, initialItems, initialGaps, initialSummary }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>('input')
  const [items, setItems] = useState<RequirementItem[]>(initialItems)
  const [gaps, setGaps] = useState<GapWithDetails[]>(initialGaps)
  // status is kept in state so it updates when refreshData runs after partial re-evaluation
  const [status, setStatus] = useState<RequirementStatus>(initialSummary.status as RequirementStatus)

  const refreshData = useCallback(async () => {
    const [itemsRes, gapsRes, reqRes] = await Promise.all([
      fetch(`/api/requirements/${requirementId}/items`),
      fetch(`/api/requirements/${requirementId}/gaps`),
      fetch(`/api/requirements/${requirementId}`),
    ])
    if (itemsRes.ok) setItems(await itemsRes.json())
    if (gapsRes.ok) setGaps(await gapsRes.json())
    if (reqRes.ok) {
      const reqData = await reqRes.json()
      setStatus(reqData.status)
    }
  }, [requirementId])

  function handleAnalysisComplete() {
    void refreshData()
    setActiveTab('structured')
  }

  async function handleMarkReady() {
    const res = await fetch(`/api/requirements/${requirementId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'ready_for_dev' }),
    })
    if (!res.ok) {
      const data = await res.json()
      throw new Error(data.error ?? 'Failed to update status')
    }
  }

  const activeGaps = gaps.filter(g => !g.resolved_at && !g.merged_into)
  const criticalGapDescriptions = activeGaps
    .filter(g => g.severity === 'critical')
    .map(g => g.description)

  const tabs: { id: Tab; label: string }[] = [
    { id: 'input', label: 'Input' },
    { id: 'structured', label: `Structured (${items.length})` },
    { id: 'gaps', label: `Gaps (${activeGaps.length})` },
  ]

  return (
    <div>
      <RiskSummaryPanel
        requirementId={requirementId}
        initialSummary={initialSummary}
        onCriticalClick={() => setActiveTab('gaps')}
        onMajorClick={() => setActiveTab('gaps')}
        onScoreClick={() => setActiveTab('gaps')}
      />

      {/* Tab nav */}
      <div className="flex border-b mb-6">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              activeTab === tab.id
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-800'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'input' && (
        <ViewInput
          requirementId={requirementId}
          initialRawInput={initialRawInput}
          onAnalysisComplete={handleAnalysisComplete}
        />
      )}

      {activeTab === 'structured' && (
        <ViewStructured
          items={items}
          gaps={gaps}
          status={status}
          blockedGapDescriptions={criticalGapDescriptions}
          requirementId={requirementId}
          onMarkReady={handleMarkReady}
          onViewGap={() => setActiveTab('gaps')}
        />
      )}

      {activeTab === 'gaps' && (
        <ViewGaps
          requirementId={requirementId}
          gaps={gaps}
          onUpdate={() => void refreshData()}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 2: Create the requirements workspace page**

Create `app/projects/[id]/requirements/page.tsx`:
```typescript
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { buildGapsWithDetails } from '@/lib/requirements/gaps-with-details'
import { Workspace } from '@/components/requirements/workspace'
import type { Gap, Question, InvestigationTask, RequirementSummary } from '@/lib/supabase/types'

interface Props {
  params: Promise<{ id: string }>
}

export default async function RequirementsPage({ params }: Props) {
  const { id: projectId } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) redirect('/login')

  // Verify project ownership
  const { data: project } = await db
    .from('projects')
    .select('id, name')
    .eq('id', projectId)
    .eq('owner_id', user.id)
    .single()

  if (!project) redirect('/projects')

  // Get or create requirement for this project
  let { data: req } = await db
    .from('requirements')
    .select('id, title, raw_input, status, blocked_reason')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!req) {
    const { data: created } = await db
      .from('requirements')
      .insert({ project_id: projectId, title: 'Requirements', raw_input: '', status: 'draft' })
      .select('id, title, raw_input, status, blocked_reason')
      .single()
    req = created
  }

  if (!req) redirect('/projects')

  // Load workspace data in parallel
  const [
    { data: items },
    { data: gaps },
    { data: questions },
    { data: tasks },
    { data: latestScore },
  ] = await Promise.all([
    db.from('requirement_items').select('*').eq('requirement_id', req.id).order('created_at', { ascending: true }),
    db.from('gaps').select('*').eq('requirement_id', req.id),
    db.from('questions').select('*').eq('requirement_id', req.id),
    db.from('investigation_tasks').select('*').eq('requirement_id', req.id),
    db.from('completeness_scores').select('overall_score, completeness, nfr_score, confidence').eq('requirement_id', req.id).order('scored_at', { ascending: false }).limit(1).maybeSingle(),
  ])

  const gapsWithDetails = buildGapsWithDetails(
    (gaps ?? []) as Gap[],
    (questions ?? []) as Question[],
    (tasks ?? []) as InvestigationTask[]
  )

  const activeGaps = ((gaps ?? []) as Gap[]).filter(g => !g.resolved_at && !g.merged_into)
  const summary: RequirementSummary = {
    critical_count: activeGaps.filter(g => g.severity === 'critical').length,
    major_count: activeGaps.filter(g => g.severity === 'major').length,
    minor_count: activeGaps.filter(g => g.severity === 'minor').length,
    completeness: latestScore?.completeness ?? 0,
    confidence: latestScore?.confidence ?? 0,
    overall_score: latestScore?.overall_score ?? 0,
    status: req.status,
    blocked_reason: req.blocked_reason,
  }

  return (
    <main className="max-w-4xl mx-auto py-8 px-4">
      <div className="mb-6">
        <a href="/projects" className="text-sm text-gray-400 hover:text-gray-600">← Projects</a>
        <h1 className="text-xl font-bold mt-1">{project.name}</h1>
        <p className="text-sm text-gray-500">{req.title}</p>
      </div>

      <Workspace
        requirementId={req.id}
        initialRawInput={req.raw_input}
        initialItems={items ?? []}
        initialGaps={gapsWithDetails}
        initialSummary={summary}
      />
    </main>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add components/requirements/workspace.tsx app/projects/\[id\]/requirements/page.tsx
git commit -m "feat: add Workspace component and requirements workspace page"
```

---

## Task 12: Smoke test the full flow

Run all existing tests to confirm nothing in the new files broke the prior work. Then do a manual walkthrough checklist.

- [ ] **Step 1: Run full test suite**

```bash
npx vitest run
```
Expected: All existing tests pass plus the new gaps-with-details and decisions tests.

- [ ] **Step 2: Fix any type errors**

```bash
npx tsc --noEmit
```
Expected: No errors. Fix any TypeScript complaints before continuing.

- [ ] **Step 3: Manual walkthrough checklist**

With a running Supabase instance and `AI_PROVIDER=mock`, verify:
1. `/login` → can sign in
2. `/projects` → shows project list and "New Project" form
3. Create a project → redirects to workspace
4. Workspace shows View 1 (Input tab active)
5. Paste text → click "Analyze" → step progress labels appear as pipeline runs
6. After analysis → auto-switches to View 2 (Structured tab)
7. View 2 shows items grouped by type with gap badges
8. Risk Summary Panel shows counts and score
9. Clicking "3 critical" in panel switches to View 3 (Gaps tab)
10. View 3 shows gaps with questions, target role badges, linked task status
11. Expand a gap → answer textarea works, Save Answer triggers partial re-eval, panel updates via Realtime
12. "Record Decision" opens form, requires both fields, saves and resolves the gap
13. "Generate question" on a gap without one calls the on-demand route
14. Panel updates in real time after gap resolved (no page reload)
15. "Mark Ready for Dev" button disabled when critical gaps exist; tooltip explains

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: complete requirements workspace UI (Plan C)"
```
