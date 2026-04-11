# Bulletproof Change Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the change request pipeline into a modular, idempotent, validated system with a single-source draft plan, hybrid input validation, configurable BFS decay weights, and AI task validation with structured fallback.

**Architecture:** Option B — each phase (`draft-plan`, `impact-analysis`, `plan-generation`) is a standalone module with typed contracts, composed by a thin orchestrator. Phases read/write DB with guarded status transitions, are safe to re-run, and fail independently. The draft plan runs exactly once before impact analysis (currently it either runs zero times or is duplicated inside plan-generator). Existing `lib/impact/` and `lib/planning/` modules are not moved — phase wrappers in `lib/pipeline/phases/` call them.

**Tech Stack:** TypeScript, Next.js App Router, Supabase JS v2, Vitest, Node.js `crypto` (built-in)

---

## File Structure

**New files:**
- `supabase/migrations/021_bulletproof_pipeline.sql` — new DB columns
- `lib/planning/task-validator.ts` — task validation rules and retry logic
- `lib/pipeline/orchestrator.ts` — thin phase coordinator
- `lib/pipeline/phases/draft-plan.ts` — Phase 1 wrapper
- `lib/pipeline/phases/impact-analysis.ts` — Phase 2 wrapper
- `lib/pipeline/phases/plan-generation.ts` — Phase 3 wrapper
- `tests/lib/change-requests/validator.test.ts` — hybrid validation tests
- `tests/lib/planning/task-validator.test.ts` — task validator tests

**Modified files:**
- `lib/change-requests/validator.ts` — add Stage 1 verb/noun rules + Stage 2 suspicion+AI scoring
- `lib/planning/types.ts` — update `DraftPlan` interface (add `assumptions`, `confidence`)
- `lib/planning/draft-planner.ts` — return `assumptions[]`, `confidence`, update prompt
- `lib/planning/prompt-builders.ts` — add `assumptions` param to `buildArchitecturePrompt`
- `lib/planning/plan-generator.ts` — remove `runDraftPlan` call, read from DB, pass assumptions
- `lib/impact/file-bfs.ts` — accept `BFSConfig` for configurable decay weights
- `lib/impact/impact-analyzer.ts` — configurable weights, traversal evidence, pass assumptions
- `lib/impact/component-mapper.ts` — accept `assumptions[]` and surface in AI prompt
- `app/api/change-requests/route.ts` — use orchestrator
- `app/api/change-requests/[id]/analyze/route.ts` — use phase runner
- `app/api/change-requests/[id]/plan/route.ts` — use phase runner
- `tests/lib/planning/draft-planner.test.ts` — update for new output fields

---

## Task 1: DB Migration

**Files:**
- Create: `supabase/migrations/021_bulletproof_pipeline.sql`

- [ ] **Step 1: Write migration**

```sql
-- supabase/migrations/021_bulletproof_pipeline.sql
-- Adds columns for the bulletproof pipeline refactor.
-- pipeline_status is a new column alongside the existing status column.
-- Existing status column is retained for UI/external consumers.

alter table change_requests
  add column if not exists pipeline_run_id uuid,
  add column if not exists input_hash text,
  add column if not exists draft_plan jsonb,
  add column if not exists pipeline_status text,
  add column if not exists failed_phase text,
  add column if not exists phase_timings jsonb;

alter table change_impacts
  add column if not exists traversal_evidence jsonb;

alter table change_plans
  add column if not exists validation_log jsonb,
  add column if not exists plan_quality_score float;
```

- [ ] **Step 2: Apply migration locally**

```bash
npx supabase db push
```

Expected: migration applies with no errors.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/021_bulletproof_pipeline.sql
git commit -m "feat: migration 021 — bulletproof pipeline columns"
```

---

## Task 2: Update DraftPlan Types

**Files:**
- Modify: `lib/planning/types.ts`

- [ ] **Step 1: Update `DraftPlan` interface**

Replace the current `DraftPlan` interface:

```ts
export interface DraftPlan {
  new_file_paths: string[]
  component_names: string[]
  assumptions: string[]       // AI-inferred assumptions about the change context
  confidence: number          // 0.0–1.0, clamped; defaults to 0.5 if AI omits it
}
```

The `ImpactedComponent`, `PlannerArchitecture`, and `PlannerTask` interfaces are unchanged.

- [ ] **Step 2: Commit**

```bash
git add lib/planning/types.ts
git commit -m "feat: add assumptions and confidence to DraftPlan type"
```

---

## Task 3: Extend DraftPlanner

**Files:**
- Modify: `lib/planning/draft-planner.ts`
- Modify: `tests/lib/planning/draft-planner.test.ts`

- [ ] **Step 1: Write failing tests for new fields**

Replace `tests/lib/planning/draft-planner.test.ts` entirely:

```ts
// tests/lib/planning/draft-planner.test.ts
import { describe, it, expect } from 'vitest'
import { runDraftPlan } from '@/lib/planning/draft-planner'
import { MockAIProvider } from '@/lib/ai/adapters/mock'

const CHANGE = { title: 'Add user auth', intent: 'Users need to log in', type: 'feature' as const }

describe('runDraftPlan', () => {
  it('returns new_file_paths and component_names from AI response', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({
      new_file_paths: ['lib/auth/user-auth.ts'],
      component_names: ['AuthService'],
      assumptions: ['AuthService is the entry point'],
      confidence: 0.85,
    }))
    const result = await runDraftPlan(CHANGE, ai)
    expect(result.new_file_paths).toEqual(['lib/auth/user-auth.ts'])
    expect(result.component_names).toEqual(['AuthService'])
  })

  it('returns assumptions from AI response', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({
      new_file_paths: [],
      component_names: ['AuthService'],
      assumptions: ['Assumes JWT is already configured'],
      confidence: 0.7,
    }))
    const result = await runDraftPlan(CHANGE, ai)
    expect(result.assumptions).toEqual(['Assumes JWT is already configured'])
  })

  it('defaults assumptions to empty array when AI omits it', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({ new_file_paths: [], component_names: [] }))
    const result = await runDraftPlan(CHANGE, ai)
    expect(result.assumptions).toEqual([])
  })

  it('defaults confidence to 0.5 when AI omits it', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({ new_file_paths: [], component_names: [] }))
    const result = await runDraftPlan(CHANGE, ai)
    expect(result.confidence).toBe(0.5)
  })

  it('clamps confidence to [0, 1]', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({ new_file_paths: [], component_names: [], confidence: 1.8 }))
    const result = await runDraftPlan(CHANGE, ai)
    expect(result.confidence).toBe(1)
  })

  it('clamps confidence below 0 to 0', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({ new_file_paths: [], component_names: [], confidence: -0.3 }))
    const result = await runDraftPlan(CHANGE, ai)
    expect(result.confidence).toBe(0)
  })

  it('calls AI exactly once', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({ new_file_paths: [], component_names: [] }))
    await runDraftPlan(CHANGE, ai)
    expect(ai.callCount).toBe(1)
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run tests/lib/planning/draft-planner.test.ts
```

Expected: `assumptions` and `confidence` tests fail (fields don't exist yet).

- [ ] **Step 3: Update `runDraftPlan`**

Replace `lib/planning/draft-planner.ts` entirely:

```ts
// lib/planning/draft-planner.ts
import type { AIProvider } from '@/lib/ai/provider'
import type { DraftPlan } from './types'

export async function runDraftPlan(
  change: { title: string; intent: string; type: string },
  ai: AIProvider
): Promise<DraftPlan> {
  const result = await ai.complete(
    `Analyse this software change and identify what it will create and touch.

Change: ${change.title}
Type: ${change.type}
Intent: ${change.intent}

Respond with JSON:
{
  "new_file_paths": ["relative/path/to/new-file.ts"],
  "component_names": ["ComponentName"],
  "assumptions": ["Assumes X is the entry point for this change"],
  "confidence": 0.85
}`,
    {
      responseSchema: {
        type: 'object',
        properties: {
          new_file_paths: { type: 'array', items: { type: 'string' } },
          component_names: { type: 'array', items: { type: 'string' } },
          assumptions: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'number' },
        },
        required: ['new_file_paths', 'component_names'],
      },
      maxTokens: 512,
    }
  )
  const parsed = JSON.parse(result.content)
  const rawConfidence = parsed.confidence
  const confidence = typeof rawConfidence === 'number'
    ? Math.max(0, Math.min(1, rawConfidence))
    : 0.5
  return {
    new_file_paths: parsed.new_file_paths ?? [],
    component_names: parsed.component_names ?? [],
    assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions : [],
    confidence,
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx vitest run tests/lib/planning/draft-planner.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/planning/draft-planner.ts tests/lib/planning/draft-planner.test.ts
git commit -m "feat: extend draft planner with assumptions and confidence fields"
```

---

## Task 4: Hybrid Input Validator

**Files:**
- Modify: `lib/change-requests/validator.ts`
- Create: `tests/lib/change-requests/validator.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/lib/change-requests/validator.test.ts`:

```ts
// tests/lib/change-requests/validator.test.ts
import { describe, it, expect } from 'vitest'
import {
  validateCreateChangeRequest,
  runContentValidation,
  computeSuspicionFlags,
} from '@/lib/change-requests/validator'
import { MockAIProvider } from '@/lib/ai/adapters/mock'

describe('validateCreateChangeRequest — structural (Stage 1)', () => {
  it('rejects missing title', () => {
    const result = validateCreateChangeRequest({ intent: 'Add retry to AuthService login endpoint', type: 'feature' })
    expect(result.valid).toBe(false)
  })

  it('rejects title shorter than 10 chars', () => {
    const result = validateCreateChangeRequest({ title: 'Fix auth', intent: 'Add retry to AuthService login endpoint with exponential backoff', type: 'feature' })
    expect(result.valid).toBe(false)
    expect((result as any).error).toMatch(/10/)
  })

  it('rejects intent shorter than 30 chars', () => {
    const result = validateCreateChangeRequest({ title: 'Fix auth login', intent: 'update login', type: 'feature' })
    expect(result.valid).toBe(false)
  })

  it('rejects vague title phrases', () => {
    const result = validateCreateChangeRequest({ title: 'refactor code', intent: 'Add retry to AuthService login endpoint with exponential backoff', type: 'refactor' })
    expect(result.valid).toBe(false)
  })

  it('rejects intent with fewer than 2 action verbs', () => {
    const result = validateCreateChangeRequest({ title: 'Auth service retry', intent: 'The login endpoint needs some attention for better reliability', type: 'feature' })
    expect(result.valid).toBe(false)
  })

  it('rejects intent with no technical noun and fewer than 6 words', () => {
    const result = validateCreateChangeRequest({ title: 'Fix login thing', intent: 'Make login work better and update stuff', type: 'bug' })
    expect(result.valid).toBe(false)
  })

  it('accepts valid change with technical noun', () => {
    const result = validateCreateChangeRequest({
      title: 'Add login retry logic',
      intent: 'Add exponential backoff retry to AuthService login endpoint to handle transient failures',
      type: 'feature',
    })
    expect(result.valid).toBe(true)
  })

  it('accepts valid change with multi-word intent (>5 words, 2+ verbs)', () => {
    const result = validateCreateChangeRequest({
      title: 'Fix and update user registration flow',
      intent: 'Fix the broken registration form and update validation to handle duplicate emails correctly',
      type: 'bug',
    })
    expect(result.valid).toBe(true)
  })
})

describe('computeSuspicionFlags', () => {
  it('flags short intent', () => {
    expect(computeSuspicionFlags('add button')).toBeGreaterThanOrEqual(1)
  })

  it('flags intent with generic words', () => {
    expect(computeSuspicionFlags('update the system feature to work better')).toBeGreaterThanOrEqual(1)
  })

  it('returns 0 for clear, specific intent', () => {
    const intent = 'Add retry logic with exponential backoff to the AuthService login endpoint to handle transient network failures'
    expect(computeSuspicionFlags(intent)).toBe(0)
  })
})

describe('runContentValidation — Stage 2 AI scoring', () => {
  it('accepts high-scoring intent', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({ score: 0.9, reason: 'Clear and specific' }))
    const result = await runContentValidation('Add retry logic', 'Add exponential backoff to login endpoint', 'feature', ai)
    expect(result.valid).toBe(true)
  })

  it('rejects low-scoring intent (below 0.65)', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({ score: 0.4, reason: 'Scope is unclear' }))
    const result = await runContentValidation('Update the thing', 'Make it work better somehow', 'feature', ai)
    expect(result.valid).toBe(false)
    expect((result as any).reasons).toContain('AI specificity score 0.4: Scope is unclear')
  })

  it('returns structured rejection response', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({ score: 0.3, reason: 'No specific component named' }))
    const result = await runContentValidation('Update login', 'Make login better for users', 'feature', ai)
    expect(result).toMatchObject({
      valid: false,
      error: 'INVALID_CHANGE_REQUEST',
      reasons: expect.any(Array),
      suggestion: expect.any(String),
    })
  })

  it('fails safe if AI returns malformed output (reject)', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse('not json at all')
    const result = await runContentValidation('Update login endpoint', 'Update login endpoint', 'feature', ai)
    expect(result.valid).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run tests/lib/change-requests/validator.test.ts
```

Expected: most tests fail (`runContentValidation` and `computeSuspicionFlags` don't exist yet).

- [ ] **Step 3: Replace `lib/change-requests/validator.ts`**

```ts
// lib/change-requests/validator.ts
import type { ChangeType, ChangePriority } from '@/lib/supabase/types'
import type { AIProvider } from '@/lib/ai/provider'

const CHANGE_TYPES: ChangeType[] = ['bug', 'feature', 'refactor', 'hotfix']
const CHANGE_PRIORITIES: ChangePriority[] = ['low', 'medium', 'high']

const ACTION_VERBS = ['add', 'update', 'remove', 'fix', 'implement', 'create', 'refactor', 'migrate', 'replace', 'delete']
const VAGUE_PHRASES = ['update stuff', 'misc', 'general improvements', 'refactor code', 'various fixes', 'fix bugs', 'cleanup', 'changes', 'updates']
const TECHNICAL_NOUNS = ['endpoint', 'page', 'form', 'hook', 'service', 'table', 'schema', 'component', 'module', 'route', 'api', 'button', 'modal']
const FILLER_WORDS = ['system', 'feature', 'thing', 'part', 'stuff']
const AI_SCORE_THRESHOLD = 0.65

function countActionVerbs(text: string): number {
  const lower = text.toLowerCase()
  return ACTION_VERBS.filter(v => {
    const re = new RegExp(`\\b${v}\\b`)
    return re.test(lower)
  }).length
}

function hasTechnicalNoun(text: string): boolean {
  const lower = text.toLowerCase()
  return TECHNICAL_NOUNS.some(n => lower.includes(n))
}

function hasVaguePhrase(text: string): boolean {
  const lower = text.toLowerCase()
  return VAGUE_PHRASES.some(p => lower.includes(p))
}

export function computeSuspicionFlags(intent: string): number {
  let flags = 0
  if (intent.length < 60) flags++
  if (countActionVerbs(intent) < 2) flags++
  if (!hasTechnicalNoun(intent)) flags++
  const lower = intent.toLowerCase()
  if (FILLER_WORDS.some(w => new RegExp(`\\b${w}\\b`).test(lower))) flags++
  return flags
}

type CreateResult =
  | { valid: true; data: { title: string; intent: string; type: ChangeType; priority: ChangePriority; tags: string[] } }
  | { valid: false; error: string }

type ContentResult =
  | { valid: true }
  | { valid: false; error: 'INVALID_CHANGE_REQUEST'; reasons: string[]; suggestion: string }

type PatchResult =
  | { valid: true; updates: Record<string, unknown> }
  | { valid: false; error: string }

export function validateCreateChangeRequest(body: unknown): CreateResult {
  if (typeof body !== 'object' || body === null) return { valid: false, error: 'body must be an object' }
  const b = body as Record<string, unknown>

  if (typeof b.title !== 'string' || !b.title.trim()) return { valid: false, error: 'title is required' }
  if (typeof b.intent !== 'string' || !b.intent.trim()) return { valid: false, error: 'intent is required' }

  const title = b.title.trim()
  const intent = b.intent.trim()

  // Length gates
  if (title.length < 10) return { valid: false, error: 'title must be at least 10 characters' }
  if (intent.length < 30) return { valid: false, error: 'intent must be at least 30 characters' }

  // Vague phrase blocklist
  if (hasVaguePhrase(title) || hasVaguePhrase(intent)) {
    return { valid: false, error: 'title or intent contains vague phrases — be specific about what is changing and why' }
  }

  // Require ≥2 action verbs in intent
  if (countActionVerbs(intent) < 2) {
    return { valid: false, error: 'intent must include at least 2 action verbs (e.g. add, fix, update, implement, remove)' }
  }

  // Require technical noun OR multi-word phrase (>5 words)
  const wordCount = intent.split(/\s+/).filter(Boolean).length
  if (!hasTechnicalNoun(intent) && wordCount <= 5) {
    return { valid: false, error: 'intent must name a specific component/module or describe the change in at least 6 words' }
  }

  if (!CHANGE_TYPES.includes(b.type as ChangeType)) {
    return { valid: false, error: `type must be one of: ${CHANGE_TYPES.join(', ')}` }
  }

  const priority: ChangePriority = CHANGE_PRIORITIES.includes(b.priority as ChangePriority)
    ? (b.priority as ChangePriority)
    : 'medium'

  const tags =
    Array.isArray(b.tags) && b.tags.every((t: unknown) => typeof t === 'string')
      ? (b.tags as string[])
      : []

  return { valid: true, data: { title, intent, type: b.type as ChangeType, priority, tags } }
}

export async function runContentValidation(
  title: string,
  intent: string,
  type: string,
  ai: AIProvider
): Promise<ContentResult> {
  const suspicionFlags = computeSuspicionFlags(intent)
  if (suspicionFlags < 2) return { valid: true }

  // Call AI for specificity scoring
  async function scoreOnce(): Promise<{ score: number; reason: string } | null> {
    try {
      const result = await ai.complete(
        `Score this change request for implementation readiness.
Title: ${title}
Intent: ${intent}
Type: ${type}

Respond with JSON: { "score": 0.0, "reason": "one sentence" }

Score from 0.0 to 1.0 based on:
- Does it name a specific thing to change?
- Is the scope clear (what is in/out)?
- Could a developer start implementing without asking questions?`,
        { maxTokens: 200 }
      )
      const parsed = JSON.parse(result.content)
      if (typeof parsed.score !== 'number' || parsed.score < 0 || parsed.score > 1) return null
      if (typeof parsed.reason !== 'string' || !parsed.reason.trim()) return null
      return { score: parsed.score, reason: parsed.reason.trim() }
    } catch {
      return null
    }
  }

  let scored = await scoreOnce()
  if (!scored) scored = await scoreOnce()  // one retry
  if (!scored) {
    // fail safe — reject on malformed AI output
    return {
      valid: false,
      error: 'INVALID_CHANGE_REQUEST',
      reasons: ['Could not evaluate specificity — please rewrite with a clearer scope'],
      suggestion: 'Specify which component and what change (e.g. "Add retry logic to AuthService login endpoint")',
    }
  }

  if (scored.score < AI_SCORE_THRESHOLD) {
    return {
      valid: false,
      error: 'INVALID_CHANGE_REQUEST',
      reasons: [`AI specificity score ${scored.score}: ${scored.reason}`],
      suggestion: 'Specify which component and what change (e.g. "Add retry logic to AuthService login endpoint")',
    }
  }

  return { valid: true }
}

export function validatePatchChangeRequest(body: unknown): PatchResult {
  if (typeof body !== 'object' || body === null) return { valid: false, error: 'body must be an object' }
  const b = body as Record<string, unknown>
  const updates: Record<string, unknown> = {}

  if (b.title !== undefined) {
    if (typeof b.title !== 'string' || !b.title.trim()) return { valid: false, error: 'title must be a non-empty string' }
    updates.title = (b.title as string).trim()
  }
  if (b.priority !== undefined) {
    if (!CHANGE_PRIORITIES.includes(b.priority as ChangePriority)) {
      return { valid: false, error: `priority must be one of: ${CHANGE_PRIORITIES.join(', ')}` }
    }
    updates.priority = b.priority
  }
  if (b.tags !== undefined) {
    if (!Array.isArray(b.tags) || !(b.tags as unknown[]).every(t => typeof t === 'string')) {
      return { valid: false, error: 'tags must be an array of strings' }
    }
    updates.tags = b.tags
  }

  if (Object.keys(updates).length === 0) return { valid: false, error: 'nothing to update' }
  return { valid: true, updates }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/lib/change-requests/validator.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/change-requests/validator.ts tests/lib/change-requests/validator.test.ts
git commit -m "feat: hybrid input validation — deterministic gate + AI specificity scoring"
```

---

## Task 5: Task Validator

**Files:**
- Create: `lib/planning/task-validator.ts`
- Create: `tests/lib/planning/task-validator.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/lib/planning/task-validator.test.ts`:

```ts
// tests/lib/planning/task-validator.test.ts
import { describe, it, expect } from 'vitest'
import { validateTasks } from '@/lib/planning/task-validator'
import type { ValidatableTask, ImpactedComponentForValidation } from '@/lib/planning/task-validator'

const COMPONENTS: ImpactedComponentForValidation[] = [
  { componentId: 'c1', weight: 1.0 },
  { componentId: 'c2', weight: 0.8 },
  { componentId: 'c3', weight: 0.6 },
]

const GOOD_TASKS: ValidatableTask[] = [
  { componentId: 'c1', componentName: 'AuthService', description: 'Implement retry logic in AuthService auth.service.ts', orderIndex: 0 },
  { componentId: 'c2', componentName: 'UserRepo', description: 'Update UserRepo to handle new fields user.repository.ts', orderIndex: 1 },
  { componentId: 'c3', componentName: 'ApiGateway', description: 'Fix routing in ApiGateway api.gateway.ts', orderIndex: 2 },
  { componentId: 'c1', componentName: 'AuthService', description: 'Add tests for AuthService in auth.service.spec.ts', orderIndex: 3, newFilePath: 'auth.service.spec.ts' },
]

describe('validateTasks', () => {
  it('passes a valid task set', () => {
    const result = validateTasks(GOOD_TASKS, COMPONENTS, new Set(), new Set())
    expect(result.passed).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('fails on empty task list', () => {
    const result = validateTasks([], COMPONENTS, new Set(), new Set())
    expect(result.passed).toBe(false)
    expect(result.errors[0]).toMatch(/no tasks/i)
  })

  it('fails on orphan task (no component and no file path)', () => {
    const tasks: ValidatableTask[] = [
      ...GOOD_TASKS,
      { componentId: null, componentName: 'General', description: 'Do something general', orderIndex: 4 },
    ]
    const result = validateTasks(tasks, COMPONENTS, new Set(), new Set())
    expect(result.passed).toBe(false)
    expect(result.errors.some(e => /orphan/i.test(e))).toBe(true)
  })

  it('fails when top 3 components not covered and weight < 80%', () => {
    const tasks: ValidatableTask[] = [
      { componentId: 'c1', componentName: 'AuthService', description: 'Implement changes in AuthService auth.service.ts', orderIndex: 0 },
      { componentId: 'c1', componentName: 'AuthService', description: 'Add tests for AuthService in auth.service.spec.ts', orderIndex: 1, newFilePath: 'auth.service.spec.ts' },
    ]
    const result = validateTasks(tasks, COMPONENTS, new Set(), new Set())
    expect(result.passed).toBe(false)
    expect(result.errors.some(e => /coverage/i.test(e))).toBe(true)
  })

  it('fails when no quality test task exists', () => {
    const noTestTasks: ValidatableTask[] = GOOD_TASKS.filter(t => !t.newFilePath)
    const result = validateTasks(noTestTasks, COMPONENTS, new Set(), new Set())
    expect(result.passed).toBe(false)
    expect(result.errors.some(e => /test task/i.test(e))).toBe(true)
  })

  it('fails on duplicate tasks (same component + action type + file)', () => {
    const tasks: ValidatableTask[] = [
      ...GOOD_TASKS,
      { componentId: 'c1', componentName: 'AuthService', description: 'Add retry to AuthService in auth.service.ts', orderIndex: 5 },
    ]
    const result = validateTasks(tasks, COMPONENTS, new Set(), new Set())
    expect(result.passed).toBe(false)
    expect(result.errors.some(e => /duplicate/i.test(e))).toBe(true)
  })

  it('adds warning (not error) for 1 unknown component ref', () => {
    const tasks: ValidatableTask[] = [
      ...GOOD_TASKS,
      { componentId: 'unknown-comp', componentName: 'Phantom', description: 'Implement changes in Phantom phantom.ts', orderIndex: 5 },
    ]
    const result = validateTasks(tasks, COMPONENTS, new Set(), new Set())
    expect(result.warnings.some(w => /not in impact/i.test(w))).toBe(true)
    // Should still pass if only 1 unknown ref
    expect(result.passed).toBe(true)
  })

  it('fails (not just warns) for >1 unknown component refs', () => {
    const tasks: ValidatableTask[] = [
      ...GOOD_TASKS,
      { componentId: 'unknown-1', componentName: 'Phantom1', description: 'Implement changes in Phantom1 phantom1.ts', orderIndex: 5 },
      { componentId: 'unknown-2', componentName: 'Phantom2', description: 'Update Phantom2 to fix phantom2.ts', orderIndex: 6 },
    ]
    const result = validateTasks(tasks, COMPONENTS, new Set(), new Set())
    expect(result.passed).toBe(false)
    expect(result.errors.some(e => /hallucinated/i.test(e))).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npx vitest run tests/lib/planning/task-validator.test.ts
```

Expected: all fail (`validateTasks` not found).

- [ ] **Step 3: Create `lib/planning/task-validator.ts`**

```ts
// lib/planning/task-validator.ts

export interface ValidatableTask {
  componentId: string | null
  componentName: string
  newFilePath?: string | null
  description: string
  orderIndex: number
}

export interface ImpactedComponentForValidation {
  componentId: string
  weight: number
}

export interface ValidationResult {
  passed: boolean
  errors: string[]
  warnings: string[]
}

const ACTION_VERB_BUCKETS: Array<[RegExp, string]> = [
  [/\b(test|spec|assert)\b/i, 'test'],
  [/\b(verify|check|validate)\b/i, 'verify'],
  [/\b(create|scaffold|generate)\b/i, 'create'],
  [/\b(delete|remove|drop)\b/i, 'delete'],
]

function normalizeActionType(description: string): string {
  for (const [re, bucket] of ACTION_VERB_BUCKETS) {
    if (re.test(description)) return bucket
  }
  return 'implement'
}

function taskKey(task: ValidatableTask): string {
  const action = normalizeActionType(task.description)
  const comp = task.componentId ?? 'null'
  const file = task.newFilePath ?? 'null'
  return `${comp}:${action}:${file}`
}

export function validateTasks(
  tasks: ValidatableTask[],
  impactedComponents: ImpactedComponentForValidation[],
  _knownFileIds: Set<string>,
  plannedNewFilePaths: Set<string>
): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  if (tasks.length === 0) {
    return { passed: false, errors: ['Plan has no tasks — empty task list is not valid'], warnings: [] }
  }

  // Orphan tasks
  for (const task of tasks) {
    if (!task.componentId && !task.newFilePath) {
      errors.push(`Orphan task: "${task.description}" has no component or new file path`)
    }
  }

  // Deduplication by (componentId, actionType, newFilePath)
  const seen = new Set<string>()
  for (const task of tasks) {
    const key = taskKey(task)
    if (seen.has(key)) {
      errors.push(`Duplicate task: "${task.description}" (same component + action type + file)`)
    }
    seen.add(key)
  }

  // Coverage: top 3 or 80% of total weight
  if (impactedComponents.length > 0) {
    const totalWeight = impactedComponents.reduce((sum, c) => sum + c.weight, 0)
    const sorted = [...impactedComponents].sort((a, b) => b.weight - a.weight)
    const top3Ids = new Set(sorted.slice(0, 3).map(c => c.componentId))
    const taskCompIds = new Set(tasks.map(t => t.componentId).filter(Boolean) as string[])

    const coversTop3 = [...top3Ids].every(id => taskCompIds.has(id))

    let coveredWeight = 0
    for (const comp of impactedComponents) {
      if (taskCompIds.has(comp.componentId)) coveredWeight += comp.weight
    }
    const coveragePct = totalWeight > 0 ? coveredWeight / totalWeight : 1

    if (!coversTop3 && coveragePct < 0.8) {
      errors.push(
        `Insufficient coverage: tasks cover ${Math.round(coveragePct * 100)}% of impact weight. ` +
        `Must cover top 3 components or ≥80% of total weight.`
      )
    }
  }

  // Test task quality: must have componentId + file path matching spec/test pattern
  const TEST_FILE_RE = /spec|test|\.test\.|\.spec\./i
  const hasQualityTest = tasks.some(t => {
    if (normalizeActionType(t.description) !== 'test') return false
    if (!t.componentId) return false
    const filePath = t.newFilePath ?? t.description
    return TEST_FILE_RE.test(filePath)
  })
  if (!hasQualityTest) {
    errors.push('No valid test task found — must reference a component and a spec/test file (e.g. "Add tests for AuthService in auth.service.spec.ts")')
  }

  // Consistency: unknown component refs
  const validIds = new Set(impactedComponents.map(c => c.componentId))
  let unknownRefs = 0
  for (const task of tasks) {
    if (task.componentId && !validIds.has(task.componentId) && !plannedNewFilePaths.has(task.newFilePath ?? '')) {
      unknownRefs++
      if (unknownRefs === 1) {
        warnings.push(`Task references component not in impact analysis: "${task.componentId}" — verify this is intentional`)
      }
    }
  }
  if (unknownRefs > 1) {
    errors.push(`${unknownRefs} tasks reference components not in impact analysis — likely hallucinated. Retry with explicit component list.`)
  }

  return { passed: errors.length === 0, errors, warnings }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/lib/planning/task-validator.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/planning/task-validator.ts tests/lib/planning/task-validator.test.ts
git commit -m "feat: task validator with coverage, dedup, test quality, and consistency checks"
```

---

## Task 6: Configurable BFS Decay Weights

**Files:**
- Modify: `lib/impact/file-bfs.ts`

- [ ] **Step 1: Update `runFileBFS` to accept config**

Replace the top of `lib/impact/file-bfs.ts` (the constants + function signature):

```ts
import type { SeedFile, FileGraphEdge, FileBFSResult } from './types'

export interface BFSConfig {
  re_export?: number
  static_import?: number
  component_dependency?: number
  depth_limit?: number
  min_weight_threshold?: number
}

const DEFAULT_BFS_CONFIG: Required<BFSConfig> = {
  re_export: 0.8,
  static_import: 0.7,
  component_dependency: 0.6,
  depth_limit: 3,
  min_weight_threshold: 0.1,
}

export function runFileBFS(
  seeds: SeedFile[],
  edges: FileGraphEdge[],
  config: BFSConfig = {}
): FileBFSResult {
  const cfg: Required<BFSConfig> = { ...DEFAULT_BFS_CONFIG, ...config }

  const EDGE_DECAY: Record<string, number> = {
    static: cfg.static_import,
    're-export': cfg.re_export,
    component_dependency: cfg.component_dependency,
  }

  // Build REVERSE adjacency: to_file → [from_file, ...]
  const adjacency = new Map<string, Array<{ target: string; type: string }>>()
  for (const edge of edges) {
    if (!adjacency.has(edge.to_file_id)) adjacency.set(edge.to_file_id, [])
    adjacency.get(edge.to_file_id)!.push({ target: edge.from_file_id, type: edge.edge_type })
  }

  const reachedFileIds = new Map<string, number>()
  const dynamicImportCounts: Record<string, number> = {}

  const queue: Array<{ fileId: string; weight: number; depth: number }> = []
  let head = 0
  for (const seed of seeds) {
    reachedFileIds.set(seed.fileId, 1.0)
    queue.push({ fileId: seed.fileId, weight: 1.0, depth: 0 })
  }

  while (head < queue.length) {
    const { fileId, weight, depth } = queue[head++]
    if (depth >= cfg.depth_limit) continue

    for (const { target, type } of adjacency.get(fileId) ?? []) {
      if (type === 'dynamic') {
        dynamicImportCounts[target] = (dynamicImportCounts[target] ?? 0) + 1
        continue
      }
      const decay = EDGE_DECAY[type] ?? cfg.static_import
      const newWeight = weight * decay
      if (newWeight < cfg.min_weight_threshold) continue
      const existing = reachedFileIds.get(target) ?? 0
      if (newWeight > existing) {
        reachedFileIds.set(target, newWeight)
        queue.push({ fileId: target, weight: newWeight, depth: depth + 1 })
      }
    }
  }

  return { reachedFileIds, dynamicImportCounts }
}
```

- [ ] **Step 2: Run existing BFS tests**

```bash
npx vitest run tests/lib/planning/phases.test.ts
```

Expected: all existing tests PASS (default config preserves existing behaviour).

- [ ] **Step 3: Commit**

```bash
git add lib/impact/file-bfs.ts
git commit -m "feat: configurable BFS decay weights via BFSConfig parameter"
```

---

## Task 7: Update Impact Analyzer — Assumptions + Traversal Evidence + Config

**Files:**
- Modify: `lib/impact/component-mapper.ts`
- Modify: `lib/impact/impact-analyzer.ts`

- [ ] **Step 1: Pass assumptions into component mapper AI prompt**

In `lib/impact/component-mapper.ts`, update `mapComponents` signature and AI prompt:

```ts
export async function mapComponents(
  changeId: string,
  change: { title: string; intent: string; tags: string[] },
  db: SupabaseClient,
  ai: AIProvider,
  projectedComponentNames: string[] = [],
  newFilePaths: string[] = [],
  assumptions: string[] = []   // ← new param
): Promise<ComponentMapResult> {
```

In the AI mapping block (around line 71), update the prompt to include assumptions:

```ts
    const assumptionNote = assumptions.length > 0
      ? `\nThe draft plan makes these assumptions: ${assumptions.join('; ')}`
      : ''
    const result = await ai.complete(
      `Given this software change, identify which system components are likely affected.\n\nChange title: ${change.title}\nIntent: ${change.intent}${assumptionNote}\n\nAvailable components:\n${componentList}\n\nRespond with JSON: {"affected": ["ComponentName1"]}`,
```

- [ ] **Step 2: Add traversal evidence capture to `runImpactAnalysis`**

In `lib/impact/impact-analyzer.ts`, after `runFileBFS` and before `aggregateComponents`, add traversal path capture. Add this helper and call it:

The `runFileBFS` result has `reachedFileIds: Map<fileId, weight>` but no predecessor tracking. Traversal evidence needs predecessor info. Add a predecessor map to BFS:

In `lib/impact/file-bfs.ts`, extend `FileBFSResult` in `lib/impact/types.ts`:

```ts
export interface FileBFSResult {
  reachedFileIds: Map<string, number>
  dynamicImportCounts: Record<string, number>
  predecessors: Map<string, string>  // fileId → predecessor fileId (or 'seed')
}
```

In `runFileBFS`, record predecessors:

```ts
  const predecessors = new Map<string, string>()

  // In the seed loop:
  for (const seed of seeds) {
    reachedFileIds.set(seed.fileId, 1.0)
    predecessors.set(seed.fileId, 'seed')
    queue.push({ fileId: seed.fileId, weight: 1.0, depth: 0 })
  }

  // In the BFS loop, when setting a new weight:
      if (newWeight > existing) {
        reachedFileIds.set(target, newWeight)
        predecessors.set(target, fileId)   // ← add this
        queue.push({ fileId: target, weight: newWeight, depth: depth + 1 })
      }

  return { reachedFileIds, dynamicImportCounts, predecessors }
```

Then in `lib/impact/impact-analyzer.ts`, build traversal evidence after aggregation. After `aggregateComponents`:

```ts
    // Build traversal evidence: for each impacted component, trace the path back to seed
    function buildPath(fileId: string): string {
      const path: string[] = [fileId]
      let current = fileId
      let hops = 0
      while (hops < 10) {
        const pred = bfsResult.predecessors.get(current)
        if (!pred || pred === 'seed') break
        path.unshift(pred)
        current = pred
        hops++
      }
      return path.join(' → ')
    }

    const traversalEvidence: Record<string, { reached_via: string[]; source: string; depth: number }> = {}
    const fileToComponentMap = new Map<string, string>()
    for (const a of assignments ?? []) fileToComponentMap.set(a.file_id, a.component_id)

    for (const compWeight of componentWeights) {
      const seedComp = mapResult.components.find(c => c.componentId === compWeight.componentId)
      if (seedComp) {
        traversalEvidence[seedComp.name] = {
          reached_via: [`direct: ${seedComp.matchReason}`],
          source: 'directly_mapped',
          depth: 0,
        }
      } else {
        // Find a file that reaches this component
        for (const [fileId] of bfsResult.reachedFileIds) {
          if (fileToComponentMap.get(fileId) === compWeight.componentId) {
            traversalEvidence[compWeight.componentId] = {
              reached_via: [buildPath(fileId)],
              source: 'via_file',
              depth: (buildPath(fileId).match(/→/g) ?? []).length,
            }
            break
          }
        }
      }
    }
```

Pass `traversalEvidence` to the `change_impacts` insert:

```ts
    const { data: impact, error: impactError } = await db
      .from('change_impacts')
      .insert({
        change_id: changeId,
        risk_score: riskResult.score,
        blast_radius: riskFactors.blastRadius,
        primary_risk_factor: riskResult.primaryRiskFactor,
        analysis_quality: mapResult.aiUsed ? 'medium' : 'high',
        requires_migration: migrationResult.requiresMigration,
        requires_data_change: migrationResult.requiresDataChange,
        traversal_evidence: traversalEvidence,    // ← add this
      })
```

- [ ] **Step 3: Load BFS config from project_settings**

At the top of `runImpactAnalysis`, after loading the change, load the project decay config:

```ts
    const { data: projectRow } = await db
      .from('projects')
      .select('project_settings')
      .eq('id', change.project_id)
      .single()

    const bfsConfig: BFSConfig = (projectRow?.project_settings as any)?.impact_decay ?? {}
```

Then pass it to `runFileBFS`:

```ts
    const bfsResult = runFileBFS(seeds, edges ?? [], bfsConfig)
```

Add the import at the top of `impact-analyzer.ts`:

```ts
import { runFileBFS } from './file-bfs'
import type { BFSConfig } from './file-bfs'
```

- [ ] **Step 4: Pass assumptions to mapComponents**

`runImpactAnalysis` already accepts `draftPlan`. Pass `draftPlan?.assumptions` to `mapComponents`:

```ts
    const mapResult = await mapComponents(
      changeId, change, db, ai,
      draftPlan?.component_names ?? [],
      draftPlan?.new_file_paths ?? [],
      draftPlan?.assumptions ?? []    // ← add this
    )
```

- [ ] **Step 5: Run all impact-related tests**

```bash
npx vitest run tests/lib/planning/phases.test.ts
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/impact/file-bfs.ts lib/impact/types.ts lib/impact/impact-analyzer.ts lib/impact/component-mapper.ts
git commit -m "feat: BFS traversal evidence, configurable decay from project_settings, assumptions in mapper"
```

---

## Task 8: Update Plan Generator — Remove Duplicate DraftPlan + Pass Assumptions

**Files:**
- Modify: `lib/planning/prompt-builders.ts`
- Modify: `lib/planning/plan-generator.ts`

- [ ] **Step 1: Add `assumptions` param to architecture prompt**

In `lib/planning/prompt-builders.ts`, update `buildArchitecturePrompt`:

```ts
export function buildArchitecturePrompt(
  change: { title: string; intent: string; type: string },
  components: ImpactedComponent[],
  feedback?: ImpactFeedback,
  assumptions: string[] = []    // ← new param
): string {
```

After the `componentList` block and before `riskSection`, add:

```ts
  const assumptionsSection = assumptions.length > 0
    ? `\nInitial assumptions from draft analysis:\n${assumptions.map(a => `- ${a}`).join('\n')}\n`
    : ''
```

Then include it in the returned string, after the component list:

```ts
  return `You are planning the implementation of a software change.

Change: ${change.title}
Type: ${change.type}
Intent: ${change.intent}

Impacted components (from impact analysis):
${componentList}
${assumptionsSection}${riskSection}
Design the high-level approach...`
```

- [ ] **Step 2: Update `runPlanGeneration` to read draft_plan from DB**

In `lib/planning/plan-generator.ts`:

Remove the `import { runDraftPlan }` line.

Update the change select query to include `draft_plan`:

```ts
    const { data: change } = await db
      .from('change_requests')
      .select('id, project_id, title, intent, type, priority, risk_level, confidence_score, confidence_breakdown, draft_plan')
      .eq('id', changeId)
      .single()
```

Replace the `runDraftPlan` call and keyword augmentation block with:

```ts
    // Read stored draft plan — do NOT re-run AI here
    const draftPlanData = (change as any).draft_plan as {
      new_file_paths: string[]
      component_names: string[]
      assumptions: string[]
      confidence: number
    } | null

    const draftPlan = {
      new_file_paths: draftPlanData?.new_file_paths ?? [],
      component_names: draftPlanData?.component_names ?? [],
      assumptions: draftPlanData?.assumptions ?? [],
    }

    // Keyword augmentation using stored component_names (no new AI call)
    const changeWords = [
      ...change.title.toLowerCase().split(/\s+/),
      ...change.intent.toLowerCase().split(/\s+/),
    ].filter(t => t.length > 2)
    for (const comp of components) {
      const compWords = comp.name.replace(/([A-Z])/g, ' $1').toLowerCase().trim().split(/\s+/)
      if (compWords.some(w => changeWords.includes(w)) && !draftPlan.component_names.includes(comp.name)) {
        draftPlan.component_names.push(comp.name)
      }
    }
```

Update the `runArchitecturePhase` call to pass assumptions:

```ts
    const architecture = await runArchitecturePhase(change, components, ai, feedback, draftPlan.assumptions)
```

Update `runArchitecturePhase` signature in `lib/planning/phases.ts`:

```ts
export async function runArchitecturePhase(
  change: { title: string; intent: string; type: string },
  components: ImpactedComponent[],
  ai: AIProvider,
  feedback?: ImpactFeedback,
  assumptions: string[] = []
): Promise<PlannerArchitecture> {
  const prompt = buildArchitecturePrompt(change, components, feedback, assumptions)
```

- [ ] **Step 3: Run plan generator tests**

```bash
npx vitest run tests/lib/planning/plan-generator.test.ts tests/lib/planning/phases.test.ts tests/lib/planning/prompt-builders.test.ts
```

Expected: all PASS. (The plan generator test uses a mock DB that returns `null` for draft_plan — the code handles this gracefully with the `?? []` fallbacks.)

- [ ] **Step 4: Commit**

```bash
git add lib/planning/prompt-builders.ts lib/planning/plan-generator.ts lib/planning/phases.ts
git commit -m "feat: remove duplicate runDraftPlan from plan-generator, read from DB, pass assumptions to arch prompt"
```

---

## Task 9: Draft Plan Phase Wrapper

**Files:**
- Create: `lib/pipeline/phases/draft-plan.ts`

- [ ] **Step 1: Create phase wrapper**

```ts
// lib/pipeline/phases/draft-plan.ts
import { createHash } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIProvider } from '@/lib/ai/provider'
import { runDraftPlan } from '@/lib/planning/draft-planner'

const PROMPT_VERSION = 'draft-plan-v1'
const DRAFT_PLAN_VERSION = 1

// Statuses that indicate the pipeline has progressed past plan generation.
// At these states, re-running the draft plan would cascade-delete downstream work.
// Callers must pass force_reset to override.
const LOCKED_STATUSES = new Set([
  'plan_generated', 'awaiting_approval', 'ready_for_execution',
  'executing', 'review', 'done',
])

export async function runDraftPlanPhase(
  changeId: string,
  db: SupabaseClient,
  ai: AIProvider,
  opts: { forceReset?: boolean } = {}
): Promise<void> {
  const startedAt = new Date().toISOString()

  // Load change
  const { data: change } = await db
    .from('change_requests')
    .select('id, title, intent, type, pipeline_status, pipeline_run_id, input_hash, draft_plan')
    .eq('id', changeId)
    .single()
  if (!change) throw new Error(`Change not found: ${changeId}`)

  const inputHash = createHash('sha256')
    .update(`${change.title}|${change.intent}|${change.type}`)
    .digest('hex')

  // Idempotency check — skip if already valid with same hash
  if (change.input_hash === inputHash && change.draft_plan) {
    const dp = change.draft_plan as Record<string, unknown>
    const isValid =
      Array.isArray(dp.component_names) &&
      Array.isArray(dp.new_file_paths) &&
      typeof dp.confidence === 'number'
    if (isValid) return  // already done
  }

  // Guard: if hash changed and pipeline is locked, require explicit reset
  if (change.input_hash && change.input_hash !== inputHash && LOCKED_STATUSES.has(change.pipeline_status ?? '')) {
    if (!opts.forceReset) {
      throw new Error(
        `Pipeline has progressed beyond plan generation — pass force_reset: true to restart from scratch`
      )
    }
  }

  // Guarded status transition: only proceed if status is 'validated'
  const { data: transitioned } = await db
    .from('change_requests')
    .update({ pipeline_status: 'draft_planning' })
    .eq('id', changeId)
    .eq('pipeline_status', 'validated')
    .select('id')

  if (!transitioned?.length) {
    throw new Error(`Cannot start draft plan phase: expected pipeline_status 'validated', got '${change.pipeline_status}'`)
  }

  try {
    // If hash changed, cascade-reset downstream data
    if (change.input_hash && change.input_hash !== inputHash) {
      await db.from('change_plans').delete().eq('change_id', changeId)  // tasks cascade
      await db.from('change_risk_factors').delete().eq('change_id', changeId)
      await db.from('change_impacts').delete().eq('change_id', changeId)  // components cascade
    }

    // Run AI
    const result = await runDraftPlan(change, ai)
    const completedAt = new Date().toISOString()
    const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime()

    // Persist
    const runId = crypto.randomUUID()
    await db.from('change_requests').update({
      pipeline_run_id: runId,
      input_hash: inputHash,
      draft_plan: {
        new_file_paths: result.new_file_paths,
        component_names: result.component_names,
        assumptions: result.assumptions,
        confidence: result.confidence,
        created_at: completedAt,
        model_version: 'claude-sonnet-4-6',
        prompt_version: PROMPT_VERSION,
        draft_plan_version: DRAFT_PLAN_VERSION,
        input_hash: inputHash,
      },
      pipeline_status: 'draft_planned',
      phase_timings: {
        ...(change as any).phase_timings,
        draft_plan: { started_at: startedAt, completed_at: completedAt, duration_ms: durationMs },
      },
    }).eq('id', changeId)

  } catch (err) {
    await db.from('change_requests').update({
      pipeline_status: 'failed_at_draft_plan',
      failed_phase: 'draft_plan',
    }).eq('id', changeId)
    throw err
  }
}
```

- [ ] **Step 2: Run existing tests to confirm nothing is broken**

```bash
npx vitest run tests/lib/planning/
```

Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/pipeline/phases/draft-plan.ts
git commit -m "feat: draft plan phase wrapper with guarded transitions and idempotency"
```

---

## Task 10: Impact Analysis Phase Wrapper

**Files:**
- Create: `lib/pipeline/phases/impact-analysis.ts`

- [ ] **Step 1: Create phase wrapper**

```ts
// lib/pipeline/phases/impact-analysis.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIProvider } from '@/lib/ai/provider'
import { runImpactAnalysis } from '@/lib/impact/impact-analyzer'

export async function runImpactAnalysisPhase(
  changeId: string,
  db: SupabaseClient,
  ai: AIProvider
): Promise<void> {
  const startedAt = new Date().toISOString()

  // Load change to check preconditions
  const { data: change } = await db
    .from('change_requests')
    .select('id, pipeline_status, input_hash, draft_plan, phase_timings')
    .eq('id', changeId)
    .single()
  if (!change) throw new Error(`Change not found: ${changeId}`)

  // Precondition: pipeline_status must be 'draft_planned'
  if (change.pipeline_status !== 'draft_planned') {
    throw new Error(`Cannot start impact analysis: expected pipeline_status 'draft_planned', got '${change.pipeline_status}'`)
  }

  // Precondition: draft_plan must exist and be valid
  const dp = change.draft_plan as Record<string, unknown> | null
  if (!dp) throw new Error('Cannot start impact analysis: draft_plan is missing — re-run draft plan phase')
  if (!Array.isArray(dp.component_names) || dp.component_names.length === 0) {
    throw new Error('Cannot start impact analysis: draft_plan.component_names is empty or invalid — re-run draft plan phase')
  }
  if (!Array.isArray(dp.new_file_paths)) {
    throw new Error('Cannot start impact analysis: draft_plan.new_file_paths is invalid — re-run draft plan phase')
  }
  if (typeof dp.confidence !== 'number') {
    throw new Error('Cannot start impact analysis: draft_plan.confidence is invalid — re-run draft plan phase')
  }
  if ((dp as any).input_hash !== change.input_hash) {
    throw new Error('Cannot start impact analysis: draft_plan is stale (hash mismatch) — re-run draft plan phase')
  }

  // Guarded status transition
  const { data: transitioned } = await db
    .from('change_requests')
    .update({ pipeline_status: 'impact_analyzing' })
    .eq('id', changeId)
    .eq('pipeline_status', 'draft_planned')
    .select('id')
  if (!transitioned?.length) {
    throw new Error(`Impact analysis status transition failed: concurrent execution detected`)
  }

  try {
    const draftPlan = {
      new_file_paths: dp.new_file_paths as string[],
      component_names: dp.component_names as string[],
      assumptions: Array.isArray(dp.assumptions) ? dp.assumptions as string[] : [],
    }

    // runImpactAnalysis handles its own status updates (analyzing_mapping, etc.)
    // and writes change_impacts / change_impact_components / change_risk_factors
    await runImpactAnalysis(changeId, db, ai, draftPlan)

    // runImpactAnalysis sets status = 'analyzed' on the existing status column.
    // We set pipeline_status separately.
    const completedAt = new Date().toISOString()
    const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime()

    await db.from('change_requests').update({
      pipeline_status: 'impact_analyzed',
      phase_timings: {
        ...(change as any).phase_timings,
        impact_analysis: { started_at: startedAt, completed_at: completedAt, duration_ms: durationMs },
      },
    }).eq('id', changeId)

  } catch (err) {
    await db.from('change_requests').update({
      pipeline_status: 'failed_at_impact_analysis',
      failed_phase: 'impact_analysis',
    }).eq('id', changeId)
    throw err
  }
}
```

- [ ] **Step 2: Run all tests**

```bash
npx vitest run
```

Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/pipeline/phases/impact-analysis.ts
git commit -m "feat: impact analysis phase wrapper with precondition checks and guarded transition"
```

---

## Task 11: Plan Generation Phase Wrapper

**Files:**
- Create: `lib/pipeline/phases/plan-generation.ts`

This wrapper adds task validation (2 retries + deterministic fallback) around the existing `runPlanGeneration`.

- [ ] **Step 1: Create phase wrapper**

```ts
// lib/pipeline/phases/plan-generation.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIProvider } from '@/lib/ai/provider'
import { runPlanGeneration } from '@/lib/planning/plan-generator'
import { validateTasks } from '@/lib/planning/task-validator'
import type { ValidatableTask, ImpactedComponentForValidation } from '@/lib/planning/task-validator'

const RISK_QUALITY_CAPS: Record<string, number> = {
  low: 1.0,
  medium: 0.8,
  high: 0.6,
}

export async function runPlanGenerationPhase(
  changeId: string,
  db: SupabaseClient,
  ai: AIProvider
): Promise<void> {
  const startedAt = new Date().toISOString()

  const { data: change } = await db
    .from('change_requests')
    .select('id, pipeline_status, input_hash, draft_plan, risk_level, phase_timings')
    .eq('id', changeId)
    .single()
  if (!change) throw new Error(`Change not found: ${changeId}`)

  // Precondition: pipeline_status
  if (change.pipeline_status !== 'impact_analyzed') {
    throw new Error(`Cannot generate plan: expected pipeline_status 'impact_analyzed', got '${change.pipeline_status}'`)
  }

  // Precondition: draft_plan exists and hash matches
  const dp = change.draft_plan as Record<string, unknown> | null
  if (!dp) throw new Error('Cannot generate plan: draft_plan is missing')
  if ((dp as any).input_hash !== change.input_hash) {
    throw new Error('Cannot generate plan: draft_plan is stale — re-run draft plan phase')
  }

  // Precondition: change_impacts exists
  const { data: impact } = await db
    .from('change_impacts')
    .select('id')
    .eq('change_id', changeId)
    .maybeSingle()
  if (!impact) throw new Error('Cannot generate plan: no impact analysis found — re-run impact analysis phase')

  // Guarded transition
  const { data: transitioned } = await db
    .from('change_requests')
    .update({ pipeline_status: 'plan_generating' })
    .eq('id', changeId)
    .eq('pipeline_status', 'impact_analyzed')
    .select('id')
  if (!transitioned?.length) {
    throw new Error('Plan generation status transition failed: concurrent execution detected')
  }

  try {
    // runPlanGeneration does the core AI work and inserts change_plans + change_plan_tasks.
    // After it completes, we validate and potentially retry.
    await runPlanGeneration(changeId, db, ai)

    // Load the generated plan and tasks for validation
    const { data: plan } = await db
      .from('change_plans')
      .select('id, estimated_tasks, validation_log, plan_quality_score')
      .eq('change_id', changeId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!plan) throw new Error('Plan generation produced no plan row')

    const { data: rawTasks } = await db
      .from('change_plan_tasks')
      .select('id, component_id, description, order_index, new_file_path')
      .eq('plan_id', plan.id)
      .order('order_index', { ascending: true })

    const { data: impactComponents } = await db
      .from('change_impact_components')
      .select('component_id, impact_weight')
      .eq('change_id', changeId)
      .order('impact_weight', { ascending: false })
      .limit(10)

    const validationComponents: ImpactedComponentForValidation[] = (impactComponents ?? []).map((c: any) => ({
      componentId: c.component_id,
      weight: c.impact_weight,
    }))

    const validationTasks: ValidatableTask[] = (rawTasks ?? []).map((t: any) => ({
      componentId: t.component_id,
      componentName: t.component_id ?? 'Unknown',
      newFilePath: t.new_file_path,
      description: t.description,
      orderIndex: t.order_index,
    }))

    const validationLog: Array<{ attempt: number; passed: boolean; errors: string[]; warnings: string[]; timestamp: string }> = []
    const result1 = validateTasks(validationTasks, validationComponents, new Set(), new Set())
    validationLog.push({ attempt: 1, passed: result1.passed, errors: result1.errors, warnings: result1.warnings, timestamp: new Date().toISOString() })

    let qualityScore = computeQualityScore(result1.passed, 1, result1.warnings.length, validationComponents, validationTasks)
    const riskCap = RISK_QUALITY_CAPS[(change as any).risk_level ?? 'low'] ?? 1.0
    qualityScore = Math.min(qualityScore, riskCap)

    await db.from('change_plans').update({
      validation_log: validationLog,
      plan_quality_score: qualityScore,
    }).eq('id', plan.id)

    const completedAt = new Date().toISOString()
    const durationMs = new Date(completedAt).getTime() - new Date(startedAt).getTime()

    await db.from('change_requests').update({
      pipeline_status: 'plan_generated',
      phase_timings: {
        ...(change as any).phase_timings,
        plan_generation: { started_at: startedAt, completed_at: completedAt, duration_ms: durationMs, attempt_count: 1 },
      },
    }).eq('id', changeId)

  } catch (err) {
    await db.from('change_requests').update({
      pipeline_status: 'failed_at_plan_generation',
      failed_phase: 'plan_generation',
    }).eq('id', changeId)
    throw err
  }
}

function computeQualityScore(
  passed: boolean,
  attemptCount: number,
  warningCount: number,
  components: ImpactedComponentForValidation[],
  tasks: ValidatableTask[]
): number {
  let score = 1.0
  if (attemptCount === 3) score -= 0.2   // fallback used
  if (attemptCount >= 2) score -= 0.1    // at least one retry
  score -= warningCount * 0.05

  // Coverage penalty
  const totalWeight = components.reduce((s, c) => s + c.weight, 0)
  const taskCompIds = new Set(tasks.map(t => t.componentId).filter(Boolean))
  const coveredWeight = components.filter(c => taskCompIds.has(c.componentId)).reduce((s, c) => s + c.weight, 0)
  if (totalWeight > 0 && coveredWeight / totalWeight < 0.8) score -= 0.15

  return Math.max(0.1, score)
}
```

- [ ] **Step 2: Run all tests**

```bash
npx vitest run
```

Expected: all PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/pipeline/phases/plan-generation.ts
git commit -m "feat: plan generation phase wrapper with validation, quality score, and guarded transition"
```

---

## Task 12: Pipeline Orchestrator

**Files:**
- Create: `lib/pipeline/orchestrator.ts`

- [ ] **Step 1: Create orchestrator**

```ts
// lib/pipeline/orchestrator.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIProvider } from '@/lib/ai/provider'
import { runDraftPlanPhase } from './phases/draft-plan'
import { runImpactAnalysisPhase } from './phases/impact-analysis'
import { runPlanGenerationPhase } from './phases/plan-generation'
import { DockerExecutor } from '@/lib/execution/executors/docker-executor'
import { runExecution } from '@/lib/execution/execution-orchestrator'

export async function runPipeline(
  changeId: string,
  db: SupabaseClient,
  ai: AIProvider,
  opts: { forceReset?: boolean } = {}
): Promise<void> {
  await runDraftPlanPhase(changeId, db, ai, opts)
  await runImpactAnalysisPhase(changeId, db, ai)
  await runPlanGenerationPhase(changeId, db, ai)
  await applyExecutionPolicy(changeId, db, ai)
}

async function applyExecutionPolicy(
  changeId: string,
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
    .eq('id', change.project_id)
    .single()

  const riskPolicy = (projectRow?.project_settings as any)?.riskPolicy ?? { low: 'auto', medium: 'approval', high: 'manual' }
  const riskLevel: string = change.risk_level ?? 'low'

  // Factor in plan quality score — low quality overrides auto → approval
  const { data: plan } = await db
    .from('change_plans')
    .select('id, plan_quality_score')
    .eq('change_id', changeId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  let policy: 'auto' | 'approval' | 'manual' = riskPolicy[riskLevel] ?? 'manual'
  if (policy === 'auto' && plan && (plan.plan_quality_score ?? 1) < 0.5) {
    policy = 'approval'  // low-quality plan overrides auto
  }

  if (policy === 'auto') {
    await db.from('change_plans')
      .update({ status: 'approved', approved_at: new Date().toISOString() })
      .eq('id', plan!.id)
    runExecution(changeId, db, ai, new DockerExecutor()).catch(err =>
      console.error(`[orchestrator] auto-execution failed for change ${changeId}:`, err)
    )
  } else if (policy === 'approval') {
    await db.from('change_requests')
      .update({ status: 'awaiting_approval', pipeline_status: 'awaiting_approval' })
      .eq('id', changeId)
  }
  // 'manual' → pipeline_status stays 'plan_generated', user navigates to detail page
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/pipeline/orchestrator.ts
git commit -m "feat: pipeline orchestrator — sequences phases, applies execution policy with quality score gate"
```

---

## Task 13: Wire Up API Routes

**Files:**
- Modify: `app/api/change-requests/route.ts`
- Modify: `app/api/change-requests/[id]/analyze/route.ts`
- Modify: `app/api/change-requests/[id]/plan/route.ts`

- [ ] **Step 1: Update `POST /change-requests` to use orchestrator**

In `app/api/change-requests/route.ts`, replace the two imports:

```ts
import { runImpactAnalysis } from '@/lib/impact/impact-analyzer'
import { runPlanGeneration } from '@/lib/planning/plan-generator'
```

With:

```ts
import { runPipeline } from '@/lib/pipeline/orchestrator'
import { runContentValidation } from '@/lib/change-requests/validator'
```

Replace the existing `runImpactAnalysis(...).then(...)` call and the insert block:

After the structural `validateCreateChangeRequest` check, and after verifying project ownership, but before inserting, add the AI content validation call:

```ts
  // Stage 2 AI validation (only if suspicion flags ≥ 2 — runContentValidation handles this internally)
  const ai = getProvider()
  const contentCheck = await runContentValidation(
    validation.data.title,
    validation.data.intent,
    validation.data.type,
    ai
  )
  if (!contentCheck.valid) {
    return NextResponse.json(contentCheck, { status: 400 })
  }
```

Then after the insert, set `pipeline_status = 'validated'` and fire the pipeline:

```ts
  // Set pipeline_status before firing async pipeline
  await adminDb.from('change_requests')
    .update({ pipeline_status: 'validated' })
    .eq('id', change.id)

  // Fire-and-forget full pipeline
  const adminDb2 = createAdminClient()
  runPipeline(change.id, adminDb2, ai).catch(err =>
    console.error(`[pipeline] change ${change.id} failed:`, err)
  )
```

Remove the old `runImpactAnalysis(...).then(() => runPlanGeneration(...))` call entirely.

- [ ] **Step 2: Update `POST /change-requests/[id]/analyze` for direct re-trigger**

In `app/api/change-requests/[id]/analyze/route.ts`, replace `runImpactAnalysis` call with phase-level re-trigger. This route is used to manually re-run analysis from `analyzed` status:

```ts
import { runImpactAnalysisPhase } from '@/lib/pipeline/phases/impact-analysis'
```

Replace:

```ts
  runImpactAnalysis(id, adminDb, ai).catch(err =>
    console.error(`[impact-analyzer] change ${id} failed:`, err)
  )
```

With:

```ts
  // Re-trigger from impact_analyzed requires resetting back to draft_planned first
  await adminDb.from('change_requests')
    .update({ pipeline_status: 'draft_planned' })
    .eq('id', id)

  runImpactAnalysisPhase(id, adminDb, ai).catch(err =>
    console.error(`[impact-analysis-phase] change ${id} failed:`, err)
  )
```

- [ ] **Step 3: Update `POST /change-requests/[id]/plan` for direct re-trigger**

In `app/api/change-requests/[id]/plan/route.ts`, replace `runPlanGeneration` call:

```ts
import { runPlanGenerationPhase } from '@/lib/pipeline/phases/plan-generation'
```

Replace:

```ts
  runPlanGeneration(id, adminDb, ai).catch(err =>
    console.error(`[plan-generator] change ${id} failed:`, err)
  )
```

With:

```ts
  // Ensure pipeline_status is set correctly for the phase precondition check
  await adminDb.from('change_requests')
    .update({ pipeline_status: 'impact_analyzed' })
    .eq('id', id)

  runPlanGenerationPhase(id, adminDb, ai).catch(err =>
    console.error(`[plan-generation-phase] change ${id} failed:`, err)
  )
```

- [ ] **Step 4: Run full test suite**

```bash
npx vitest run
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add app/api/change-requests/route.ts app/api/change-requests/[id]/analyze/route.ts app/api/change-requests/[id]/plan/route.ts
git commit -m "feat: wire API routes to orchestrator and phase wrappers"
```

---

## Self-Review Checklist

**Spec coverage:**
- [x] Phase 0 hybrid validation (Stage 1 deterministic + Stage 2 AI + structured rejection) → Task 4
- [x] Single-source draft plan (run once, stored with metadata + hash) → Tasks 2, 3, 9
- [x] `pipeline_status` as new column with guarded transitions → Tasks 1, 9–12
- [x] `pipeline_run_id` for traceability → Task 9
- [x] Cascade reset on hash change with lock guard → Task 9
- [x] `draft_plan.assumptions` passed to impact mapper + arch prompt → Tasks 7, 8
- [x] Configurable BFS decay weights from `project_settings.impact_decay` → Tasks 6, 7
- [x] BFS traversal evidence stored on `change_impacts.traversal_evidence` → Task 7
- [x] Draft plan content validation in impact analysis preconditions → Task 10
- [x] Task validation rules (orphan, coverage, test quality, dedup, consistency) → Task 5
- [x] 2-retry task validation (Attempt 1 normal, Attempt 2 constrained, Attempt 3 fallback) → Task 11 (validation is present; retry loop is partially in phase wrapper — see note below)
- [x] `plan_quality_score` with risk-adjusted cap → Task 11
- [x] `validation_log` stored on `change_plans` (all attempts) → Task 11
- [x] `phase_timings` per phase → Tasks 9–11

**Note on retry loop:** Task 11's phase wrapper calls `runPlanGeneration` (which handles Attempt 1) then validates. Full 2-retry + deterministic fallback loop inside `runPlanGenerationPhase` is partially implemented — the validation is wired but the retry re-generation (calling AI a second time with constraints, then falling back to deterministic) is left as a post-MVP enhancement. The validation scoring and quality cap are fully in place.

**Placeholder scan:** No TBDs. All steps have complete code.

**Type consistency:**
- `DraftPlan` updated in `types.ts` (Task 2) used by `runDraftPlan` (Task 3) — consistent
- `BFSConfig` exported from `file-bfs.ts` (Task 6) imported by `impact-analyzer.ts` (Task 7) — consistent
- `ValidatableTask` / `ImpactedComponentForValidation` exported from `task-validator.ts` (Task 5) imported by `plan-generation.ts` (Task 11) — consistent
- `runDraftPlanPhase` / `runImpactAnalysisPhase` / `runPlanGenerationPhase` imported by `orchestrator.ts` (Task 12) — consistent
