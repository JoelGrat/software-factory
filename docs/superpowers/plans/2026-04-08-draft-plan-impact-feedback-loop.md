# Draft Plan → Impact Feedback → Refinement Loop

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the planning pipeline with a Draft Plan → Impact Feedback → Refinement loop so the planner can see risk from its own projected changes before committing to a task list.

**Architecture:** `runPlanGeneration` gains three new phases: (1) a fast draft-plan that projects which files and components will be touched, (2) an impact-feedback phase that evaluates the draft against the existing impact analysis and returns structured risk feedback, (3) a refinement phase that rewrites the task list for high-risk or uncertain changes. Low-risk changes skip the AI refinement call entirely. Draft and feedback are stored as jsonb on `change_plans` for auditability.

**Tech Stack:** TypeScript, Vitest, Supabase, MockAIProvider (test doubles already in place)

---

## File Map

| File | Change |
|------|--------|
| `lib/planning/types.ts` | Add `DraftPlan`, `ImpactFeedback` |
| `lib/planning/draft-planner.ts` | **Create** — `runDraftPlan` |
| `lib/planning/prompt-builders.ts` | Add `buildDraftPlanPrompt`, `buildImpactFeedbackPrompt`, `buildRefinementPrompt`; update `buildArchitecturePrompt` |
| `lib/planning/phases.ts` | Add `runImpactFeedbackPhase`, `runRefinementPhase`; update `runArchitecturePhase` signature |
| `lib/planning/plan-generator.ts` | Wire new phases; store jsonb on plan row |
| `supabase/migrations/015_plan_feedback.sql` | **Create** — add `draft_plan jsonb`, `impact_feedback jsonb` to `change_plans` |
| `tests/lib/planning/draft-planner.test.ts` | **Create** |
| `tests/lib/planning/phases.test.ts` | Add tests for new phases |
| `tests/lib/planning/plan-generator.test.ts` | Add integration tests for the new loop |

---

### Task 1: Add DraftPlan and ImpactFeedback types

**Files:**
- Modify: `lib/planning/types.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/lib/planning/phases.test.ts` (just shape-check that these types can be imported):

```typescript
import type { DraftPlan, ImpactFeedback } from '@/lib/planning/types'

describe('DraftPlan type', () => {
  it('has the expected shape', () => {
    const d: DraftPlan = { newFiles: [], touchedComponents: [], intentMap: {} }
    expect(d.newFiles).toBeInstanceOf(Array)
    expect(d.touchedComponents).toBeInstanceOf(Array)
    expect(typeof d.intentMap).toBe('object')
  })
})

describe('ImpactFeedback type', () => {
  it('has the expected shape', () => {
    const f: ImpactFeedback = {
      riskLevel: 'medium',
      reasons: ['auth component touched'],
      uncertainty: 'low',
      projectedComponents: [],
    }
    expect(f.riskLevel).toBe('medium')
    expect(f.reasons).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/lib/planning/phases.test.ts 2>&1 | tail -20
```

Expected: FAIL — `DraftPlan` and `ImpactFeedback` not exported from `@/lib/planning/types`

- [ ] **Step 3: Add the types to lib/planning/types.ts**

Append to the end of `lib/planning/types.ts`:

```typescript
export interface DraftPlan {
  newFiles: string[]
  touchedComponents: string[]
  intentMap: Record<string, string>
}

export interface ImpactFeedback {
  riskLevel: 'low' | 'medium' | 'high'
  reasons: string[]
  uncertainty: 'low' | 'medium' | 'high'
  projectedComponents: string[]
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/lib/planning/phases.test.ts 2>&1 | tail -20
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/planning/types.ts tests/lib/planning/phases.test.ts
git commit -m "feat: add DraftPlan and ImpactFeedback types"
```

---

### Task 2: DB migration — add draft_plan and impact_feedback columns

**Files:**
- Create: `supabase/migrations/015_plan_feedback.sql`

- [ ] **Step 1: Write the failing test**

Add to `tests/lib/planning/plan-generator.test.ts`:

```typescript
it('stores draft_plan jsonb on the change_plans insert', async () => {
  const { db, inserts } = makeMockDb()
  const ai = makeAI()
  ai.setDefaultResponse(JSON.stringify({
    approach: 'Fix the auth system',
    branchName: 'sf/abc123-fix-auth',
    testApproach: 'Unit tests',
    estimatedFiles: 3,
    componentApproaches: { AuthService: 'Update token TTL' },
    newFiles: [],
    touchedComponents: ['AuthService'],
    intentMap: { AuthService: 'Update TTL' },
    tasks: [{ description: 'Update token config' }],
    riskLevel: 'low',
    reasons: [],
    uncertainty: 'low',
    projectedComponents: [],
  }))

  await runPlanGeneration('cr1', db, ai)

  const planInsert = inserts.find(i => i.table === 'change_plans')
  expect(planInsert?.data).toHaveProperty('draft_plan')
  expect(planInsert?.data).toHaveProperty('impact_feedback')
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/lib/planning/plan-generator.test.ts 2>&1 | tail -20
```

Expected: FAIL — `draft_plan` not present in insert

- [ ] **Step 3: Create the migration file**

Create `supabase/migrations/015_plan_feedback.sql`:

```sql
-- 015_plan_feedback.sql
-- Store draft plan and impact feedback on change_plans for auditability.
alter table change_plans
  add column if not exists draft_plan jsonb,
  add column if not exists impact_feedback jsonb;
```

- [ ] **Step 4: Commit migration (tests still failing — wired up in Task 5)**

```bash
git add supabase/migrations/015_plan_feedback.sql
git commit -m "feat: add draft_plan and impact_feedback columns to change_plans"
```

---

### Task 3: Draft Planner — prompt + implementation

**Files:**
- Modify: `lib/planning/prompt-builders.ts`
- Create: `lib/planning/draft-planner.ts`
- Create: `tests/lib/planning/draft-planner.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/lib/planning/draft-planner.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { runDraftPlan } from '@/lib/planning/draft-planner'
import { MockAIProvider } from '@/lib/ai/adapters/mock'

const CHANGE = { title: 'Add token caching', intent: 'Reduce auth DB calls', type: 'feature' as const }

describe('runDraftPlan', () => {
  it('returns DraftPlan with correct shape', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({
      newFiles: ['lib/auth/token-cache.ts'],
      touchedComponents: ['AuthService'],
      intentMap: { AuthService: 'Add cache lookup before DB call' },
    }))

    const result = await runDraftPlan(CHANGE, ai)

    expect(result.newFiles).toEqual(['lib/auth/token-cache.ts'])
    expect(result.touchedComponents).toEqual(['AuthService'])
    expect(result.intentMap['AuthService']).toBe('Add cache lookup before DB call')
  })

  it('calls AI exactly once', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({
      newFiles: [], touchedComponents: [], intentMap: {},
    }))

    await runDraftPlan(CHANGE, ai)
    expect(ai.callCount).toBe(1)
  })

  it('returns empty arrays on malformed AI response', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse('{}')

    const result = await runDraftPlan(CHANGE, ai)
    expect(result.newFiles).toEqual([])
    expect(result.touchedComponents).toEqual([])
    expect(result.intentMap).toEqual({})
  })

  it('throws on invalid JSON from AI', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse('not json')

    await expect(runDraftPlan(CHANGE, ai)).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/lib/planning/draft-planner.test.ts 2>&1 | tail -20
```

Expected: FAIL — module `@/lib/planning/draft-planner` not found

- [ ] **Step 3: Add buildDraftPlanPrompt to lib/planning/prompt-builders.ts**

Append to `lib/planning/prompt-builders.ts`:

```typescript
export function buildDraftPlanPrompt(
  change: { title: string; intent: string; type: string }
): string {
  return `You are doing a fast first-pass analysis of a software change to identify what it will create and touch.

Change: ${change.title}
Type: ${change.type}
Intent: ${change.intent}

Based on the title and intent, identify:
1. New files that will need to be created (relative paths, e.g. "lib/auth/token-cache.ts")
2. Existing system component names that will be modified
3. Per-component intent — what will change in each one

Respond with JSON:
{
  "newFiles": ["relative/path/to/new-file.ts"],
  "touchedComponents": ["ComponentName"],
  "intentMap": {
    "ComponentName": "Brief description of what changes in this component"
  }
}`
}
```

- [ ] **Step 4: Create lib/planning/draft-planner.ts**

```typescript
// lib/planning/draft-planner.ts
import type { AIProvider } from '@/lib/ai/provider'
import type { DraftPlan } from './types'
import { buildDraftPlanPrompt } from './prompt-builders'

export async function runDraftPlan(
  change: { title: string; intent: string; type: string },
  ai: AIProvider
): Promise<DraftPlan> {
  const prompt = buildDraftPlanPrompt(change)
  const result = await ai.complete(prompt, {
    responseSchema: {
      type: 'object',
      properties: {
        newFiles: { type: 'array', items: { type: 'string' } },
        touchedComponents: { type: 'array', items: { type: 'string' } },
        intentMap: { type: 'object' },
      },
      required: ['newFiles', 'touchedComponents', 'intentMap'],
    },
    maxTokens: 1024,
  })
  const parsed = JSON.parse(result.content)
  return {
    newFiles: parsed.newFiles ?? [],
    touchedComponents: parsed.touchedComponents ?? [],
    intentMap: parsed.intentMap ?? {},
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run tests/lib/planning/draft-planner.test.ts 2>&1 | tail -20
```

Expected: PASS (4/4)

- [ ] **Step 6: Commit**

```bash
git add lib/planning/prompt-builders.ts lib/planning/draft-planner.ts tests/lib/planning/draft-planner.test.ts
git commit -m "feat: add draft planner with buildDraftPlanPrompt and runDraftPlan"
```

---

### Task 4: Impact Feedback Phase

**Files:**
- Modify: `lib/planning/prompt-builders.ts`
- Modify: `lib/planning/phases.ts`
- Modify: `tests/lib/planning/phases.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/lib/planning/phases.test.ts`:

```typescript
import { runImpactFeedbackPhase } from '@/lib/planning/phases'
import type { DraftPlan, ImpactFeedback } from '@/lib/planning/types'

const DRAFT_PLAN: DraftPlan = {
  newFiles: ['lib/auth/token-cache.ts'],
  touchedComponents: ['AuthService', 'TokenCache'],
  intentMap: {
    AuthService: 'Add cache lookup before DB',
    TokenCache: 'New cache layer',
  },
}

describe('runImpactFeedbackPhase', () => {
  it('returns ImpactFeedback with correct shape', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({
      riskLevel: 'medium',
      reasons: ['draft touches auth component'],
      uncertainty: 'low',
      projectedComponents: ['TokenCache'],
    }))

    const result = await runImpactFeedbackPhase(CHANGE, DRAFT_PLAN, COMPONENTS, ai)

    expect(['low', 'medium', 'high']).toContain(result.riskLevel)
    expect(result.reasons).toBeInstanceOf(Array)
    expect(['low', 'medium', 'high']).toContain(result.uncertainty)
    expect(result.projectedComponents).toBeInstanceOf(Array)
  })

  it('returns low-risk fallback on AI error', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse('not json')

    const result = await runImpactFeedbackPhase(CHANGE, DRAFT_PLAN, COMPONENTS, ai)

    expect(result.riskLevel).toBe('low')
    expect(result.uncertainty).toBe('high')
  })

  it('calls AI exactly once', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({
      riskLevel: 'low', reasons: [], uncertainty: 'low', projectedComponents: [],
    }))

    await runImpactFeedbackPhase(CHANGE, DRAFT_PLAN, COMPONENTS, ai)
    expect(ai.callCount).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/lib/planning/phases.test.ts 2>&1 | tail -20
```

Expected: FAIL — `runImpactFeedbackPhase` not exported

- [ ] **Step 3: Add buildImpactFeedbackPrompt to lib/planning/prompt-builders.ts**

Append to `lib/planning/prompt-builders.ts`:

```typescript
export function buildImpactFeedbackPrompt(
  change: { title: string; intent: string },
  draftPlan: DraftPlan,
  existingComponents: ImpactedComponent[]
): string {
  const componentList = existingComponents.length > 0
    ? existingComponents
        .map(c => `- ${c.name} (${c.type}, impact: ${Math.round(c.impactWeight * 100)}%)`)
        .join('\n')
    : '(none identified)'

  const touchedList = draftPlan.touchedComponents.join(', ') || 'none'
  const newFileList = draftPlan.newFiles.join(', ') || 'none'
  const intentEntries = Object.entries(draftPlan.intentMap)
    .map(([comp, intent]) => `  - ${comp}: ${intent}`)
    .join('\n') || '  (none)'

  return `You are evaluating risk introduced by a draft implementation plan.

Change: ${change.title}
Intent: ${change.intent}

Impact analysis found these existing components:
${componentList}

Draft plan intends to:
- Touch components: ${touchedList}
- Create new files: ${newFileList}
- Per-component changes:
${intentEntries}

Evaluate whether the draft plan introduces risk beyond what the impact analysis captured.
Flag any components the draft mentions that were NOT in the impact analysis as projectedComponents.

Respond with JSON:
{
  "riskLevel": "low|medium|high",
  "reasons": ["specific risk reason"],
  "uncertainty": "low|medium|high",
  "projectedComponents": ["ComponentName not in impact analysis"]
}`
}
```

Add the import for `DraftPlan` in `prompt-builders.ts` — update the import line at the top:

```typescript
import type { ImpactedComponent, PlannerArchitecture, PlannerTask, DraftPlan, ImpactFeedback } from './types'
```

- [ ] **Step 4: Add runImpactFeedbackPhase to lib/planning/phases.ts**

Add import at the top of `lib/planning/phases.ts` (update existing import):

```typescript
import type { ImpactedComponent, PlannerArchitecture, PlannerTask, DraftPlan, ImpactFeedback } from './types'
import { buildArchitecturePrompt, buildComponentTasksPrompt, buildFallbackTasksPrompt, buildSpecPrompt, buildImpactFeedbackPrompt } from './prompt-builders'
```

Append the new function to `lib/planning/phases.ts`:

```typescript
export async function runImpactFeedbackPhase(
  change: { title: string; intent: string },
  draftPlan: DraftPlan,
  existingComponents: ImpactedComponent[],
  ai: AIProvider
): Promise<ImpactFeedback> {
  const prompt = buildImpactFeedbackPrompt(change, draftPlan, existingComponents)
  try {
    const result = await ai.complete(prompt, {
      responseSchema: {
        type: 'object',
        properties: {
          riskLevel: { type: 'string', enum: ['low', 'medium', 'high'] },
          reasons: { type: 'array', items: { type: 'string' } },
          uncertainty: { type: 'string', enum: ['low', 'medium', 'high'] },
          projectedComponents: { type: 'array', items: { type: 'string' } },
        },
        required: ['riskLevel', 'reasons', 'uncertainty', 'projectedComponents'],
      },
      maxTokens: 1024,
    })
    const parsed = JSON.parse(result.content)
    return {
      riskLevel: parsed.riskLevel ?? 'low',
      reasons: parsed.reasons ?? [],
      uncertainty: parsed.uncertainty ?? 'low',
      projectedComponents: parsed.projectedComponents ?? [],
    }
  } catch {
    return { riskLevel: 'low', reasons: [], uncertainty: 'high', projectedComponents: [] }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run tests/lib/planning/phases.test.ts 2>&1 | tail -20
```

Expected: all existing tests + 3 new tests PASS

- [ ] **Step 6: Commit**

```bash
git add lib/planning/prompt-builders.ts lib/planning/phases.ts tests/lib/planning/phases.test.ts
git commit -m "feat: add impact feedback phase with buildImpactFeedbackPrompt and runImpactFeedbackPhase"
```

---

### Task 5: Refinement Phase

**Files:**
- Modify: `lib/planning/prompt-builders.ts`
- Modify: `lib/planning/phases.ts`
- Modify: `tests/lib/planning/phases.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/lib/planning/phases.test.ts`:

```typescript
import { runRefinementPhase } from '@/lib/planning/phases'

const BASE_TASKS: PlannerTask[] = [
  { description: 'Update token TTL', componentId: 'c1', componentName: 'AuthService', orderIndex: 0 },
  { description: 'Update user lookup', componentId: 'c2', componentName: 'UserRepository', orderIndex: 1 },
]

const LOW_FEEDBACK: ImpactFeedback = {
  riskLevel: 'low', reasons: [], uncertainty: 'low', projectedComponents: [],
}

const HIGH_FEEDBACK: ImpactFeedback = {
  riskLevel: 'high',
  reasons: ['auth component with unknown deps'],
  uncertainty: 'medium',
  projectedComponents: ['TokenCache'],
}

describe('runRefinementPhase', () => {
  it('returns tasks unchanged when risk is low and uncertainty is low', async () => {
    const ai = new MockAIProvider()
    const result = await runRefinementPhase(CHANGE, BASE_TASKS, LOW_FEEDBACK, ai)
    expect(result).toEqual(BASE_TASKS)
    expect(ai.callCount).toBe(0)
  })

  it('calls AI and returns refined tasks for high risk', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({
      tasks: [
        { description: 'Verify current token TTL behavior', componentName: 'AuthService', orderIndex: 0 },
        { description: 'Update token TTL', componentName: 'AuthService', orderIndex: 1 },
        { description: 'Update user lookup', componentName: 'UserRepository', orderIndex: 2 },
      ],
    }))

    const result = await runRefinementPhase(CHANGE, BASE_TASKS, HIGH_FEEDBACK, ai)

    expect(result.length).toBeGreaterThan(BASE_TASKS.length)
    expect(ai.callCount).toBe(1)
  })

  it('returns original tasks on AI error', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse('not json')

    const result = await runRefinementPhase(CHANGE, BASE_TASKS, HIGH_FEEDBACK, ai)
    expect(result).toEqual(BASE_TASKS)
  })

  it('maps componentId from original tasks by componentName', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({
      tasks: [
        { description: 'Verify current token TTL behavior', componentName: 'AuthService', orderIndex: 0 },
        { description: 'Update token TTL', componentName: 'AuthService', orderIndex: 1 },
      ],
    }))

    const result = await runRefinementPhase(CHANGE, BASE_TASKS, HIGH_FEEDBACK, ai)

    const authTasks = result.filter(t => t.componentName === 'AuthService')
    expect(authTasks.every(t => t.componentId === 'c1')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/lib/planning/phases.test.ts 2>&1 | tail -20
```

Expected: FAIL — `runRefinementPhase` not exported

- [ ] **Step 3: Add buildRefinementPrompt to lib/planning/prompt-builders.ts**

Append to `lib/planning/prompt-builders.ts`:

```typescript
export function buildRefinementPrompt(
  change: { title: string; intent: string },
  tasks: PlannerTask[],
  feedback: ImpactFeedback
): string {
  const taskList = tasks
    .map(t => `${t.orderIndex + 1}. [${t.componentName}] ${t.description}`)
    .join('\n')

  const reasons = feedback.reasons.join('; ') || 'none'
  const projected = feedback.projectedComponents.join(', ') || 'none'

  return `You are refining an implementation task list based on risk feedback.

Change: ${change.title}
Intent: ${change.intent}

Risk feedback:
- Risk level: ${feedback.riskLevel}
- Reasons: ${reasons}
- Uncertainty: ${feedback.uncertainty}
- Components not in original impact analysis: ${projected}

Current task list:
${taskList}

Refine the task list:
- For high-risk or uncertain components: prepend a "verify current behavior of X" task before modifying them
- For projected components (not in original impact analysis): ensure they have appropriate tasks
- Do NOT remove existing tasks — only add or split them
- Each task must be completable in under an hour
- Keep componentName accurate on every task

Respond with JSON:
{
  "tasks": [
    { "description": "Task description", "componentName": "ComponentName", "orderIndex": 0 }
  ]
}`
}
```

Update the import in `prompt-builders.ts` to also include `PlannerTask` in the `ImpactFeedback` import (already included from Task 4 step).

- [ ] **Step 4: Add runRefinementPhase to lib/planning/phases.ts**

Update imports in `lib/planning/phases.ts`:

```typescript
import { buildArchitecturePrompt, buildComponentTasksPrompt, buildFallbackTasksPrompt, buildSpecPrompt, buildImpactFeedbackPrompt, buildRefinementPrompt } from './prompt-builders'
```

Append to `lib/planning/phases.ts`:

```typescript
export async function runRefinementPhase(
  change: { title: string; intent: string },
  tasks: PlannerTask[],
  feedback: ImpactFeedback,
  ai: AIProvider
): Promise<PlannerTask[]> {
  if (feedback.riskLevel === 'low' && feedback.uncertainty === 'low') {
    return tasks
  }

  const prompt = buildRefinementPrompt(change, tasks, feedback)
  try {
    const result = await ai.complete(prompt, {
      responseSchema: {
        type: 'object',
        properties: {
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                description: { type: 'string' },
                componentName: { type: 'string' },
                orderIndex: { type: 'number' },
              },
              required: ['description', 'componentName', 'orderIndex'],
            },
          },
        },
        required: ['tasks'],
      },
      maxTokens: 2048,
    })
    const parsed = JSON.parse(result.content)
    const refined = (parsed.tasks ?? []) as Array<{ description: string; componentName: string; orderIndex: number }>

    const componentIdByName = new Map(tasks.map(t => [t.componentName, t.componentId]))
    return refined.map((t, i) => ({
      description: t.description,
      componentId: componentIdByName.get(t.componentName) ?? null,
      componentName: t.componentName,
      orderIndex: i,
    }))
  } catch {
    return tasks
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run tests/lib/planning/phases.test.ts 2>&1 | tail -20
```

Expected: all tests PASS

- [ ] **Step 6: Commit**

```bash
git add lib/planning/prompt-builders.ts lib/planning/phases.ts tests/lib/planning/phases.test.ts
git commit -m "feat: add refinement phase with buildRefinementPrompt and runRefinementPhase"
```

---

### Task 6: Wire into plan-generator — architecture context + full loop

**Files:**
- Modify: `lib/planning/phases.ts` — update `runArchitecturePhase` to accept optional context
- Modify: `lib/planning/prompt-builders.ts` — update `buildArchitecturePrompt` to embed draft + feedback
- Modify: `lib/planning/plan-generator.ts` — run Draft → Feedback → Architecture → Tasks → Refine → store jsonb
- Modify: `tests/lib/planning/plan-generator.test.ts` — add integration tests for new loop

- [ ] **Step 1: Write the failing test**

Add to `tests/lib/planning/plan-generator.test.ts`:

```typescript
it('stores draft_plan and impact_feedback on the change_plans insert', async () => {
  const { db, inserts } = makeMockDb()
  const ai = makeAI()

  await runPlanGeneration('cr1', db, ai)

  const planInsert = inserts.find(i => i.table === 'change_plans')
  expect(planInsert?.data).toHaveProperty('draft_plan')
  expect(planInsert?.data).toHaveProperty('impact_feedback')
})

it('runs refinement for high-risk feedback and produces more tasks than base', async () => {
  const { db, inserts } = makeMockDb()
  const ai = makeAI()

  let callIndex = 0
  ai.setDefaultResponse(JSON.stringify({
    approach: 'Fix the auth system',
    branchName: 'sf/abc123-fix-auth',
    testApproach: 'Unit tests',
    estimatedFiles: 3,
    componentApproaches: { AuthService: 'Update token TTL' },
    // Used for draft plan
    newFiles: [],
    touchedComponents: ['AuthService'],
    intentMap: { AuthService: 'Update TTL' },
    // Used for impact feedback
    riskLevel: 'high',
    reasons: ['auth component touched'],
    uncertainty: 'medium',
    projectedComponents: [],
    // Used for per-component tasks
    tasks: [{ description: 'Update token config' }],
    // Used for refinement
  }))

  // Override: return high-risk feedback on the 2nd call, refined tasks on the last
  const responses = [
    // 1. draft plan
    JSON.stringify({ newFiles: [], touchedComponents: ['AuthService'], intentMap: { AuthService: 'Update TTL' } }),
    // 2. impact feedback — high risk
    JSON.stringify({ riskLevel: 'high', reasons: ['auth touched'], uncertainty: 'medium', projectedComponents: [] }),
    // 3. architecture
    JSON.stringify({ approach: 'Fix', branchName: 'sf/x-fix', testApproach: 'tests', estimatedFiles: 2, componentApproaches: { AuthService: 'Update TTL' } }),
    // 4. component tasks
    JSON.stringify({ tasks: [{ description: 'Update token config' }] }),
    // 5. refinement — adds a verification task
    JSON.stringify({ tasks: [
      { description: 'Verify current token TTL', componentName: 'AuthService', orderIndex: 0 },
      { description: 'Update token config', componentName: 'AuthService', orderIndex: 1 },
    ]}),
    // 6. spec
    '# Spec\n\nDo the work.',
  ]
  let idx = 0
  ai.complete = async () => ({ content: responses[idx++] ?? '{}', usage: { inputTokens: 0, outputTokens: 0 } })

  await runPlanGeneration('cr1', db, ai)

  const taskInsert = inserts.find(i => i.table === 'change_plan_tasks')
  const tasks = taskInsert?.data as Array<{ description: string }>
  expect(tasks?.length).toBeGreaterThanOrEqual(2)
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/lib/planning/plan-generator.test.ts 2>&1 | tail -20
```

Expected: FAIL — `draft_plan` not in insert, refinement not wired

- [ ] **Step 3: Update buildArchitecturePrompt to accept optional context**

In `lib/planning/prompt-builders.ts`, replace the existing `buildArchitecturePrompt` signature:

```typescript
// old:
export function buildArchitecturePrompt(
  change: { title: string; intent: string; type: string },
  components: ImpactedComponent[]
): string {

// new:
export function buildArchitecturePrompt(
  change: { title: string; intent: string; type: string },
  components: ImpactedComponent[],
  draftPlan?: DraftPlan,
  feedback?: ImpactFeedback
): string {
```

Inside the function body, append a context section before the closing `Respond with JSON`:

Replace the return statement to add a draft/feedback context block:

```typescript
  const contextSection = (draftPlan || feedback) ? `
Draft plan context:
${draftPlan ? `- Files to create: ${draftPlan.newFiles.join(', ') || 'none'}
- Components to touch: ${draftPlan.touchedComponents.join(', ') || 'none'}` : ''}
${feedback && feedback.riskLevel !== 'low' ? `
Risk feedback:
- Risk level: ${feedback.riskLevel}
- Reasons: ${feedback.reasons.join('; ')}
- Uncertainty: ${feedback.uncertainty}
- Projected new components: ${feedback.projectedComponents.join(', ') || 'none'}` : ''}
` : ''
```

The full updated `buildArchitecturePrompt` function body (replace existing implementation):

```typescript
export function buildArchitecturePrompt(
  change: { title: string; intent: string; type: string },
  components: ImpactedComponent[],
  draftPlan?: DraftPlan,
  feedback?: ImpactFeedback
): string {
  const componentList = components
    .map(c => `- ${c.name} (type: ${c.type}, impact: ${Math.round(c.impactWeight * 100)}%)`)
    .join('\n')

  const contextLines: string[] = []
  if (draftPlan && (draftPlan.newFiles.length > 0 || draftPlan.touchedComponents.length > 0)) {
    contextLines.push(`Draft plan context:`)
    if (draftPlan.newFiles.length > 0) contextLines.push(`- New files to create: ${draftPlan.newFiles.join(', ')}`)
    if (draftPlan.touchedComponents.length > 0) contextLines.push(`- Components to touch: ${draftPlan.touchedComponents.join(', ')}`)
  }
  if (feedback && feedback.riskLevel !== 'low') {
    contextLines.push(`Risk feedback: ${feedback.riskLevel} risk — ${feedback.reasons.join('; ')}`)
    if (feedback.projectedComponents.length > 0) {
      contextLines.push(`Projected new components (not in impact analysis): ${feedback.projectedComponents.join(', ')}`)
    }
  }
  const contextSection = contextLines.length > 0 ? `\n${contextLines.join('\n')}\n` : ''

  return `You are planning the implementation of a software change.

Change: ${change.title}
Type: ${change.type}
Intent: ${change.intent}

Impacted components (from impact analysis):
${componentList}
${contextSection}
Design the high-level approach for implementing this change.
For each component, describe what needs to change and how.
If this change requires creating brand-new files not yet in the codebase, list their paths in newFilePaths.

Respond with JSON:
{
  "approach": "One paragraph describing the overall implementation approach",
  "branchName": "sf/xxxxxx-short-slug",
  "testApproach": "Brief testing strategy",
  "estimatedFiles": 5,
  "componentApproaches": {
    "ComponentName": "Approach for this component"
  },
  "newFilePaths": ["relative/path/to/new-file.ts"]
}`
}
```

- [ ] **Step 4: Update runArchitecturePhase to accept optional context**

In `lib/planning/phases.ts`, update the `runArchitecturePhase` signature and body:

```typescript
export async function runArchitecturePhase(
  change: { title: string; intent: string; type: string },
  components: ImpactedComponent[],
  ai: AIProvider,
  context?: { draftPlan?: DraftPlan; feedback?: ImpactFeedback }
): Promise<PlannerArchitecture> {
  const prompt = buildArchitecturePrompt(change, components, context?.draftPlan, context?.feedback)
  const result = await ai.complete(prompt, {
    responseSchema: {
      type: 'object',
      properties: {
        approach: { type: 'string' },
        branchName: { type: 'string' },
        testApproach: { type: 'string' },
        estimatedFiles: { type: 'number' },
        componentApproaches: { type: 'object' },
        newFilePaths: { type: 'array', items: { type: 'string' } },
      },
      required: ['approach', 'branchName', 'testApproach', 'estimatedFiles', 'componentApproaches'],
    },
    maxTokens: 2048,
  })

  const parsed = JSON.parse(result.content)
  return {
    approach: parsed.approach,
    branchName: parsed.branchName,
    testApproach: parsed.testApproach,
    estimatedFiles: parsed.estimatedFiles ?? 0,
    componentApproaches: parsed.componentApproaches ?? {},
    newFilePaths: parsed.newFilePaths ?? [],
  }
}
```

- [ ] **Step 5: Wire the full loop into runPlanGeneration**

In `lib/planning/plan-generator.ts`, update imports at the top:

```typescript
import type { ImpactedComponent, PlannerTask } from './types'
import { runArchitecturePhase, runComponentTasksPhase, runFallbackTasksPhase, runOrderingPhase, runSpecPhase, runImpactFeedbackPhase, runRefinementPhase } from './phases'
import { runDraftPlan } from './draft-planner'
```

In `runPlanGeneration`, after loading `components` and before `// Phase 1: Architecture`, insert:

```typescript
    // Draft phase: fast AI pass to project what will be created/touched
    const draftPlan = await runDraftPlan(change, ai)

    // Impact feedback phase: evaluate draft against existing impact analysis
    const feedback = await runImpactFeedbackPhase(change, draftPlan, components, ai)
```

Update the Architecture phase call to pass context:

```typescript
    // Phase 1: Architecture (uses draft + feedback as context)
    const architecture = await runArchitecturePhase(change, components, ai, { draftPlan, feedback })
```

Update the `change_plans` insert to include the new jsonb columns:

```typescript
    const { data: plan, error: planError } = await db
      .from('change_plans')
      .insert({
        change_id: changeId,
        status: 'draft',
        estimated_files: architecture.estimatedFiles,
        branch_name: architecture.branchName,
        draft_plan: draftPlan,
        impact_feedback: feedback,
      })
      .select('id')
      .single()
```

After `runOrderingPhase` and before writing tasks, add refinement:

```typescript
    // Phase 3b: Refinement — adjust task granularity based on risk feedback
    const refinedTasks = await runRefinementPhase(change, orderedTasks, feedback, ai)

    // Phase 3c: Re-run ordering after refinement
    const finalTasks = runOrderingPhase(refinedTasks, components)
```

Update the task writing to use `finalTasks` instead of `orderedTasks`:

```typescript
    if (finalTasks.length > 0) {
      const taskRows = finalTasks.map(t => ({
        plan_id: plan.id,
        component_id: t.componentId,
        description: t.description,
        order_index: t.orderIndex,
        status: 'pending',
        new_file_path: t.newFilePath ?? null,
      }))
      const { error: tasksError } = await db.from('change_plan_tasks').insert(taskRows)
      if (tasksError) throw tasksError
    }

    await db.from('change_plans').update({
      estimated_tasks: finalTasks.length,
    }).eq('id', plan.id)

    const specMarkdown = await runSpecPhase(change, architecture, finalTasks, ai)
```

- [ ] **Step 6: Run all planning tests**

```bash
npx vitest run tests/lib/planning/ 2>&1 | tail -30
```

Expected: all tests PASS

- [ ] **Step 7: Run full test suite to check no regressions**

```bash
npx vitest run 2>&1 | tail -30
```

Expected: all tests PASS

- [ ] **Step 8: Commit**

```bash
git add lib/planning/phases.ts lib/planning/prompt-builders.ts lib/planning/plan-generator.ts lib/planning/draft-planner.ts tests/lib/planning/plan-generator.test.ts
git commit -m "feat: wire draft plan → impact feedback → refinement loop into runPlanGeneration"
```

---

### Task 7: TypeScript check

**Files:**
- No new files — verify everything compiles

- [ ] **Step 1: Run TypeScript compiler**

```bash
npx tsc --noEmit 2>&1 | head -40
```

Expected: no errors. If there are errors, fix them before committing.

Common issues to watch for:
- `MockAIProvider.complete` being overridden with incompatible type in tests — ensure the override returns `{ content: string; usage: { inputTokens: number; outputTokens: number } }`
- `draftPlan` / `feedback` stored in `change_plans` insert — Supabase types may not know about the new columns yet; add `as any` cast if needed on the insert object only

- [ ] **Step 2: If tsc errors exist for new jsonb columns, cast the insert**

In `lib/planning/plan-generator.ts`, if TypeScript complains about `draft_plan` / `impact_feedback` not existing on the insert type, cast:

```typescript
    const { data: plan, error: planError } = await db
      .from('change_plans')
      .insert({
        change_id: changeId,
        status: 'draft',
        estimated_files: architecture.estimatedFiles,
        branch_name: architecture.branchName,
        draft_plan: draftPlan as unknown as never,
        impact_feedback: feedback as unknown as never,
      } as Parameters<ReturnType<typeof db.from>['insert']>[0])
      .select('id')
      .single()
```

Actually, use the simpler workaround — cast the whole object:

```typescript
      .insert({
        change_id: changeId,
        status: 'draft' as const,
        estimated_files: architecture.estimatedFiles,
        branch_name: architecture.branchName,
        draft_plan: draftPlan,
        impact_feedback: feedback,
      } as any)
```

- [ ] **Step 3: Commit if any casts were needed**

```bash
git add lib/planning/plan-generator.ts
git commit -m "fix: cast change_plans insert for new jsonb columns until DB types regenerated"
```
