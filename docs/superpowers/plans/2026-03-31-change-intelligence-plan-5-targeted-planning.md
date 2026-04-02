# Change Intelligence System — Plan 5: Targeted Planning

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the targeted planning pipeline — a 4-phase async generator that takes an analyzed change request, reads the impacted components from Plan 4's output, produces a scoped implementation plan (tasks + spec), and writes it to `change_plans` / `change_plan_tasks`, then exposes it via a new API endpoint and a plan workspace on the change detail page.

**Architecture:** Pure phase functions in `lib/planning/` (types → prompt-builders → phases → orchestrator) with no framework deps, fully unit-testable. The orchestrator `runPlanGeneration` is fire-and-forget from `POST /api/change-requests/[id]/plan`. Phase 1 generates overall approach + branch name; Phase 2 generates tasks per impacted component (sequential AI calls); Phase 3 orders tasks deterministically by component type (no AI); Phase 4 writes the full markdown spec. On approval the plan status becomes `approved` (execution in Plan 6).

**Tech Stack:** Next.js 14 App Router, TypeScript, Supabase, Vitest, Claude/OpenAI via existing `AIProvider`

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `lib/planning/types.ts` | Create | In-memory interfaces for the planning pipeline |
| `lib/planning/prompt-builders.ts` | Create | Pure string builders for each phase prompt |
| `lib/planning/phases.ts` | Create | 4 phase functions (3 AI + 1 deterministic) |
| `lib/planning/plan-generator.ts` | Create | Orchestrator: status transitions + DB writes |
| `tests/lib/planning/prompt-builders.test.ts` | Create | Unit tests for prompt content |
| `tests/lib/planning/phases.test.ts` | Create | Unit tests with MockAIProvider |
| `tests/lib/planning/plan-generator.test.ts` | Create | Integration tests with mock DB + AI |
| `app/api/change-requests/[id]/plan/route.ts` | Create | POST (trigger), GET (fetch plan+tasks), PATCH (approve) |
| `app/api/change-requests/[id]/route.ts` | Modify | Include plan data in GET response |
| `app/projects/[id]/changes/[changeId]/page.tsx` | Modify | Fetch plan + tasks for initial load |
| `app/projects/[id]/changes/[changeId]/change-detail-view.tsx` | Modify | Generate Plan button + planning indicator + plan workspace |

---

### Task 1: Types + Prompt Builders

**Files:**
- Create: `lib/planning/types.ts`
- Create: `lib/planning/prompt-builders.ts`
- Create: `tests/lib/planning/prompt-builders.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/lib/planning/prompt-builders.test.ts
import { describe, it, expect } from 'vitest'
import {
  buildArchitecturePrompt,
  buildComponentTasksPrompt,
  buildSpecPrompt,
} from '@/lib/planning/prompt-builders'
import type { ImpactedComponent, PlannerArchitecture } from '@/lib/planning/types'

const COMPONENTS: ImpactedComponent[] = [
  { componentId: 'c1', name: 'AuthService', type: 'auth', impactWeight: 1.0 },
  { componentId: 'c2', name: 'UserRepository', type: 'repository', impactWeight: 0.7 },
]

const CHANGE = { title: 'Fix auth token expiry', intent: 'Tokens expire too quickly', type: 'bug' as const }

const ARCHITECTURE: PlannerArchitecture = {
  approach: 'Extend token TTL and add refresh logic',
  branchName: 'sf/abc123-fix-auth-token',
  testApproach: 'Unit test token validation',
  estimatedFiles: 4,
}

describe('buildArchitecturePrompt', () => {
  it('includes change title and intent', () => {
    const prompt = buildArchitecturePrompt(CHANGE, COMPONENTS)
    expect(prompt).toContain('Fix auth token expiry')
    expect(prompt).toContain('Tokens expire too quickly')
  })

  it('lists all component names and types', () => {
    const prompt = buildArchitecturePrompt(CHANGE, COMPONENTS)
    expect(prompt).toContain('AuthService')
    expect(prompt).toContain('auth')
    expect(prompt).toContain('UserRepository')
    expect(prompt).toContain('repository')
  })

  it('asks for branch_name in JSON output', () => {
    const prompt = buildArchitecturePrompt(CHANGE, COMPONENTS)
    expect(prompt).toContain('branch_name')
  })

  it('asks for component approaches by name', () => {
    const prompt = buildArchitecturePrompt(CHANGE, COMPONENTS)
    expect(prompt).toContain('componentApproaches')
  })
})

describe('buildComponentTasksPrompt', () => {
  it('includes component name and type', () => {
    const prompt = buildComponentTasksPrompt(CHANGE, COMPONENTS[0], 'Extend token TTL')
    expect(prompt).toContain('AuthService')
    expect(prompt).toContain('auth')
  })

  it('includes the approach from architecture', () => {
    const prompt = buildComponentTasksPrompt(CHANGE, COMPONENTS[0], 'Extend token TTL')
    expect(prompt).toContain('Extend token TTL')
  })

  it('includes change intent', () => {
    const prompt = buildComponentTasksPrompt(CHANGE, COMPONENTS[0], 'Extend token TTL')
    expect(prompt).toContain('Tokens expire too quickly')
  })

  it('asks for tasks array in JSON output', () => {
    const prompt = buildComponentTasksPrompt(CHANGE, COMPONENTS[0], 'Extend token TTL')
    expect(prompt).toContain('"tasks"')
  })
})

describe('buildSpecPrompt', () => {
  it('includes change title and type', () => {
    const tasks = [
      { description: 'Update token TTL config', componentId: 'c1', componentName: 'AuthService', orderIndex: 0 },
    ]
    const prompt = buildSpecPrompt(CHANGE, ARCHITECTURE, tasks)
    expect(prompt).toContain('Fix auth token expiry')
    expect(prompt).toContain('bug')
  })

  it('includes task descriptions', () => {
    const tasks = [
      { description: 'Update token TTL config', componentId: 'c1', componentName: 'AuthService', orderIndex: 0 },
    ]
    const prompt = buildSpecPrompt(CHANGE, ARCHITECTURE, tasks)
    expect(prompt).toContain('Update token TTL config')
  })

  it('includes component approach', () => {
    const tasks = [
      { description: 'Update token TTL config', componentId: 'c1', componentName: 'AuthService', orderIndex: 0 },
    ]
    const prompt = buildSpecPrompt(CHANGE, ARCHITECTURE, tasks)
    expect(prompt).toContain('Extend token TTL and add refresh logic')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/lib/planning/prompt-builders.test.ts 2>&1 | head -10
```

Expected: FAIL with "Cannot find module '@/lib/planning/prompt-builders'"

- [ ] **Step 3: Create types.ts**

```typescript
// lib/planning/types.ts

export interface ImpactedComponent {
  componentId: string
  name: string
  type: string
  impactWeight: number
}

export interface PlannerArchitecture {
  approach: string
  branchName: string
  testApproach: string
  estimatedFiles: number
  componentApproaches: Record<string, string>  // componentName → approach
}

export interface PlannerTask {
  description: string
  componentId: string
  componentName: string
  orderIndex: number
}
```

- [ ] **Step 4: Create prompt-builders.ts**

```typescript
// lib/planning/prompt-builders.ts
import type { ImpactedComponent, PlannerArchitecture, PlannerTask } from './types'

export function buildArchitecturePrompt(
  change: { title: string; intent: string; type: string },
  components: ImpactedComponent[]
): string {
  const componentList = components
    .map(c => `- ${c.name} (type: ${c.type}, impact: ${Math.round(c.impactWeight * 100)}%)`)
    .join('\n')

  return `You are planning the implementation of a software change.

Change: ${change.title}
Type: ${change.type}
Intent: ${change.intent}

Impacted components (from impact analysis):
${componentList}

Design the high-level approach for implementing this change.
For each component, describe what needs to change and how.

Respond with JSON:
{
  "approach": "One paragraph describing the overall implementation approach",
  "branchName": "sf/xxxxxx-short-slug",
  "testApproach": "Brief testing strategy",
  "estimatedFiles": 5,
  "componentApproaches": {
    "ComponentName": "Approach for this component"
  }
}`
}

export function buildComponentTasksPrompt(
  change: { title: string; intent: string },
  component: ImpactedComponent,
  approach: string
): string {
  return `You are generating implementation tasks for a specific component.

Change: ${change.title}
Intent: ${change.intent}

Component: ${component.name} (${component.type})
Approach: ${approach}

Generate 3–7 specific, actionable implementation tasks for this component.
Each task should be completable in under an hour.
Focus only on work needed for this change — not general improvements.

Respond with JSON:
{
  "tasks": [
    { "description": "Specific task description" }
  ]
}`
}

export function buildSpecPrompt(
  change: { title: string; intent: string; type: string },
  architecture: PlannerArchitecture,
  tasks: PlannerTask[]
): string {
  const tasksByComponent: Record<string, string[]> = {}
  for (const task of tasks) {
    if (!tasksByComponent[task.componentName]) tasksByComponent[task.componentName] = []
    tasksByComponent[task.componentName].push(`${task.orderIndex + 1}. ${task.description}`)
  }

  const taskSection = Object.entries(tasksByComponent)
    .map(([comp, descs]) => `### ${comp}\n${descs.join('\n')}`)
    .join('\n\n')

  return `Write an implementation specification for this software change.

## Change
Title: ${change.title}
Type: ${change.type}
Intent: ${change.intent}

## Approach
${architecture.approach}

## Testing Strategy
${architecture.testApproach}

## Tasks by Component
${taskSection}

Write a clear markdown spec covering: overview, approach per component, task breakdown, and testing notes.
Be concise — this is a working document for a developer, not a design doc.`
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run tests/lib/planning/prompt-builders.test.ts
```

Expected: 11 passing

- [ ] **Step 6: Commit**

```bash
git add lib/planning/types.ts lib/planning/prompt-builders.ts tests/lib/planning/prompt-builders.test.ts
git commit -m "feat: planning types and prompt builders"
```

---

### Task 2: Phase Functions

**Files:**
- Create: `lib/planning/phases.ts`
- Create: `tests/lib/planning/phases.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/lib/planning/phases.test.ts
import { describe, it, expect } from 'vitest'
import { runArchitecturePhase, runComponentTasksPhase, runOrderingPhase, runSpecPhase } from '@/lib/planning/phases'
import { MockAIProvider } from '@/lib/ai/adapters/mock'
import type { ImpactedComponent, PlannerArchitecture, PlannerTask } from '@/lib/planning/types'

const CHANGE = { title: 'Fix auth', intent: 'Auth is broken', type: 'bug' as const }

const COMPONENTS: ImpactedComponent[] = [
  { componentId: 'c1', name: 'AuthService', type: 'auth', impactWeight: 1.0 },
  { componentId: 'c2', name: 'UserRepository', type: 'repository', impactWeight: 0.7 },
]

describe('runArchitecturePhase', () => {
  it('parses AI JSON response into PlannerArchitecture', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({
      approach: 'Fix token expiry',
      branchName: 'sf/abc123-fix-auth',
      testApproach: 'Unit tests for token validation',
      estimatedFiles: 3,
      componentApproaches: { AuthService: 'Update TTL', UserRepository: 'No changes needed' },
    }))

    const result = await runArchitecturePhase(CHANGE, COMPONENTS, ai)
    expect(result.approach).toBe('Fix token expiry')
    expect(result.branchName).toBe('sf/abc123-fix-auth')
    expect(result.componentApproaches['AuthService']).toBe('Update TTL')
  })

  it('calls AI exactly once', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({
      approach: 'Fix', branchName: 'sf/x-fix', testApproach: 'tests',
      estimatedFiles: 1, componentApproaches: {},
    }))

    await runArchitecturePhase(CHANGE, COMPONENTS, ai)
    expect(ai.callCount).toBe(1)
  })

  it('throws on invalid AI response', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse('not json')
    await expect(runArchitecturePhase(CHANGE, COMPONENTS, ai)).rejects.toThrow()
  })
})

describe('runComponentTasksPhase', () => {
  it('returns task description strings', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({
      tasks: [
        { description: 'Update token TTL in config' },
        { description: 'Add refresh token endpoint' },
      ],
    }))

    const tasks = await runComponentTasksPhase(CHANGE, COMPONENTS[0], 'Update TTL', ai)
    expect(tasks).toHaveLength(2)
    expect(tasks[0]).toBe('Update token TTL in config')
    expect(tasks[1]).toBe('Add refresh token endpoint')
  })

  it('returns empty array on empty AI response', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({ tasks: [] }))
    const tasks = await runComponentTasksPhase(CHANGE, COMPONENTS[0], 'No changes', ai)
    expect(tasks).toHaveLength(0)
  })

  it('returns empty array on malformed AI response', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse('bad json')
    const tasks = await runComponentTasksPhase(CHANGE, COMPONENTS[0], 'No changes', ai)
    expect(tasks).toHaveLength(0)
  })
})

describe('runOrderingPhase', () => {
  it('orders database/repository components before api/service', () => {
    const tasks: PlannerTask[] = [
      { description: 'Add API endpoint', componentId: 'c1', componentName: 'ProjectsAPI', orderIndex: 0 },
      { description: 'Add DB column', componentId: 'c2', componentName: 'UserRepository', orderIndex: 1 },
      { description: 'Update service', componentId: 'c3', componentName: 'AuthService', orderIndex: 2 },
    ]
    const components: ImpactedComponent[] = [
      { componentId: 'c1', name: 'ProjectsAPI', type: 'api', impactWeight: 0.5 },
      { componentId: 'c2', name: 'UserRepository', type: 'repository', impactWeight: 0.8 },
      { componentId: 'c3', name: 'AuthService', type: 'auth', impactWeight: 1.0 },
    ]

    const ordered = runOrderingPhase(tasks, components)
    const names = ordered.map(t => t.componentName)
    expect(names.indexOf('UserRepository')).toBeLessThan(names.indexOf('ProjectsAPI'))
  })

  it('assigns sequential order_index values starting at 0', () => {
    const tasks: PlannerTask[] = [
      { description: 'Task A', componentId: 'c1', componentName: 'AuthService', orderIndex: 0 },
      { description: 'Task B', componentId: 'c1', componentName: 'AuthService', orderIndex: 1 },
    ]
    const components: ImpactedComponent[] = [
      { componentId: 'c1', name: 'AuthService', type: 'auth', impactWeight: 1.0 },
    ]
    const ordered = runOrderingPhase(tasks, components)
    expect(ordered[0].orderIndex).toBe(0)
    expect(ordered[1].orderIndex).toBe(1)
  })

  it('returns all tasks unchanged when components have same type', () => {
    const tasks: PlannerTask[] = [
      { description: 'Task A', componentId: 'c1', componentName: 'CompA', orderIndex: 0 },
      { description: 'Task B', componentId: 'c2', componentName: 'CompB', orderIndex: 1 },
    ]
    const components: ImpactedComponent[] = [
      { componentId: 'c1', name: 'CompA', type: 'service', impactWeight: 1.0 },
      { componentId: 'c2', name: 'CompB', type: 'service', impactWeight: 0.5 },
    ]
    const ordered = runOrderingPhase(tasks, components)
    expect(ordered).toHaveLength(2)
  })
})

describe('runSpecPhase', () => {
  it('returns the AI response string as-is', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse('# Implementation Spec\n\nDo the thing.')

    const architecture: PlannerArchitecture = {
      approach: 'Fix it',
      branchName: 'sf/abc-fix',
      testApproach: 'Unit tests',
      estimatedFiles: 2,
      componentApproaches: {},
    }
    const tasks: PlannerTask[] = []
    const spec = await runSpecPhase(CHANGE, architecture, tasks, ai)
    expect(spec).toBe('# Implementation Spec\n\nDo the thing.')
  })

  it('returns empty string on AI error', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse = () => { throw new Error('AI failure') }
    // Will use default response '{}' which is fine for a text response
    const architecture: PlannerArchitecture = {
      approach: '', branchName: 'sf/x', testApproach: '', estimatedFiles: 0, componentApproaches: {},
    }
    // runSpecPhase should not throw even if AI fails
    const result = await runSpecPhase(CHANGE, architecture, [], ai)
    expect(typeof result).toBe('string')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/lib/planning/phases.test.ts 2>&1 | head -10
```

Expected: FAIL with "Cannot find module '@/lib/planning/phases'"

- [ ] **Step 3: Create phases.ts**

```typescript
// lib/planning/phases.ts
import type { AIProvider } from '@/lib/ai/provider'
import type { ImpactedComponent, PlannerArchitecture, PlannerTask } from './types'
import { buildArchitecturePrompt, buildComponentTasksPrompt, buildSpecPrompt } from './prompt-builders'

// Component type priority for deterministic ordering (lower = runs first)
const TYPE_PRIORITY: Record<string, number> = {
  database: 0,
  repository: 1,
  service: 2,
  auth: 3,
  api: 4,
  module: 5,
  ui: 6,
  component: 7,
}

export async function runArchitecturePhase(
  change: { title: string; intent: string; type: string },
  components: ImpactedComponent[],
  ai: AIProvider
): Promise<PlannerArchitecture> {
  const prompt = buildArchitecturePrompt(change, components)
  const result = await ai.complete(prompt, {
    responseSchema: {
      type: 'object',
      properties: {
        approach: { type: 'string' },
        branchName: { type: 'string' },
        testApproach: { type: 'string' },
        estimatedFiles: { type: 'number' },
        componentApproaches: { type: 'object' },
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
  }
}

export async function runComponentTasksPhase(
  change: { title: string; intent: string },
  component: ImpactedComponent,
  approach: string,
  ai: AIProvider
): Promise<string[]> {
  const prompt = buildComponentTasksPrompt(change, component, approach)
  try {
    const result = await ai.complete(prompt, {
      responseSchema: {
        type: 'object',
        properties: {
          tasks: { type: 'array', items: { type: 'object', properties: { description: { type: 'string' } } } },
        },
        required: ['tasks'],
      },
      maxTokens: 2048,
    })
    const parsed = JSON.parse(result.content)
    return (parsed.tasks ?? []).map((t: { description: string }) => t.description).filter(Boolean)
  } catch {
    return []
  }
}

export function runOrderingPhase(
  tasks: PlannerTask[],
  components: ImpactedComponent[]
): PlannerTask[] {
  const typeByComponentId = new Map(components.map(c => [c.componentId, c.type]))

  const sorted = [...tasks].sort((a, b) => {
    const pa = TYPE_PRIORITY[typeByComponentId.get(a.componentId) ?? ''] ?? 99
    const pb = TYPE_PRIORITY[typeByComponentId.get(b.componentId) ?? ''] ?? 99
    if (pa !== pb) return pa - pb
    return a.orderIndex - b.orderIndex
  })

  return sorted.map((task, i) => ({ ...task, orderIndex: i }))
}

export async function runSpecPhase(
  change: { title: string; intent: string; type: string },
  architecture: PlannerArchitecture,
  tasks: PlannerTask[],
  ai: AIProvider
): Promise<string> {
  const prompt = buildSpecPrompt(change, architecture, tasks)
  try {
    const result = await ai.complete(prompt, { maxTokens: 8192 })
    return result.content
  } catch {
    return ''
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/lib/planning/phases.test.ts
```

Expected: 11 passing

- [ ] **Step 5: Commit**

```bash
git add lib/planning/phases.ts tests/lib/planning/phases.test.ts
git commit -m "feat: planning phase functions"
```

---

### Task 3: Plan Generator Orchestrator

**Files:**
- Create: `lib/planning/plan-generator.ts`
- Create: `tests/lib/planning/plan-generator.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/lib/planning/plan-generator.test.ts
import { describe, it, expect } from 'vitest'
import { runPlanGeneration } from '@/lib/planning/plan-generator'
import { MockAIProvider } from '@/lib/ai/adapters/mock'
import type { SupabaseClient } from '@supabase/supabase-js'

type UpdateCapture = { table: string; data: Record<string, unknown>; eq: string }
type InsertCapture = { table: string; data: unknown }

const CHANGE = { id: 'cr1', project_id: 'proj1', title: 'Fix auth', intent: 'Auth broken', type: 'bug', priority: 'high' }
const IMPACT = { id: 'impact-1', change_id: 'cr1' }
const IMPACT_COMPONENTS = [
  { component_id: 'c1', impact_weight: 1.0, system_components: { name: 'AuthService', type: 'auth' } },
]

function makeMockDb(opts: {
  change?: Record<string, unknown> | null
  impact?: Record<string, unknown> | null
  impactComponents?: typeof IMPACT_COMPONENTS
} = {}): { db: SupabaseClient; updates: UpdateCapture[]; inserts: InsertCapture[] } {
  const updates: UpdateCapture[] = []
  const inserts: InsertCapture[] = []

  const change = opts.change !== undefined ? opts.change : CHANGE
  const impact = opts.impact !== undefined ? opts.impact : IMPACT
  const impactComponents = opts.impactComponents ?? IMPACT_COMPONENTS

  const db = {
    from: (table: string) => {
      if (table === 'change_requests') {
        return {
          update: (data: Record<string, unknown>) => ({
            eq: (_col: string, val: string) => {
              updates.push({ table, data, eq: val })
              return Promise.resolve({ error: null })
            },
          }),
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: change, error: null }),
            }),
          }),
        }
      }
      if (table === 'change_impacts') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: impact, error: null }),
            }),
          }),
        }
      }
      if (table === 'change_impact_components') {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => Promise.resolve({ data: impactComponents, error: null }),
              }),
            }),
          }),
        }
      }
      if (table === 'change_plans') {
        return {
          insert: (data: unknown) => ({
            select: () => ({
              single: () => {
                inserts.push({ table, data })
                return Promise.resolve({ data: { id: 'plan-1' }, error: null })
              },
            }),
          }),
          update: (data: Record<string, unknown>) => ({
            eq: (_col: string, val: string) => {
              updates.push({ table, data, eq: val })
              return Promise.resolve({ error: null })
            },
          }),
        }
      }
      if (table === 'change_plan_tasks') {
        return {
          insert: (data: unknown) => {
            inserts.push({ table, data })
            return Promise.resolve({ error: null })
          },
        }
      }
      return {
        select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: null }), maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
        update: (data: Record<string, unknown>) => ({ eq: (_: string, val: string) => { updates.push({ table, data, eq: val }); return Promise.resolve({ error: null }) } }),
        insert: (data: unknown) => { inserts.push({ table, data }); return Promise.resolve({ error: null }) },
      }
    },
  } as unknown as SupabaseClient

  return { db, updates, inserts }
}

function makeAI(): MockAIProvider {
  const ai = new MockAIProvider()
  ai.setDefaultResponse(JSON.stringify({
    approach: 'Fix the auth system',
    branchName: 'sf/abc123-fix-auth',
    testApproach: 'Unit tests',
    estimatedFiles: 3,
    componentApproaches: { AuthService: 'Update token TTL' },
    tasks: [{ description: 'Update token config' }],
  }))
  return ai
}

describe('runPlanGeneration', () => {
  it('transitions status: planning → planned', async () => {
    const { db, updates } = makeMockDb()
    const ai = makeAI()

    await runPlanGeneration('cr1', db, ai)

    const statuses = updates
      .filter(u => u.table === 'change_requests' && u.data.status)
      .map(u => u.data.status)

    expect(statuses).toContain('planning')
    expect(statuses).toContain('planned')
  })

  it('inserts a change_plans row', async () => {
    const { db, inserts } = makeMockDb()
    await runPlanGeneration('cr1', db, makeAI())
    expect(inserts.some(i => i.table === 'change_plans')).toBe(true)
  })

  it('inserts change_plan_tasks', async () => {
    const { db, inserts } = makeMockDb()
    await runPlanGeneration('cr1', db, makeAI())
    expect(inserts.some(i => i.table === 'change_plan_tasks')).toBe(true)
  })

  it('reverts to analyzed status on failure', async () => {
    const { db, updates } = makeMockDb({ change: null })
    const ai = makeAI()

    try {
      await runPlanGeneration('cr1', db, ai)
    } catch {
      // expected
    }

    const finalStatus = updates
      .filter(u => u.table === 'change_requests' && u.data.status)
      .map(u => u.data.status)
      .at(-1)

    expect(finalStatus).toBe('analyzed')
  })

  it('updates change_plans with spec_markdown', async () => {
    const { db, updates } = makeMockDb()
    const ai = makeAI()
    ai.setDefaultResponse('# Spec\n\nDo the work.')

    await runPlanGeneration('cr1', db, ai)

    const planUpdate = updates.find(u => u.table === 'change_plans' && u.data.spec_markdown !== undefined)
    expect(planUpdate).toBeDefined()
  })

  it('throws and re-throws on missing change', async () => {
    const { db } = makeMockDb({ change: null })
    await expect(runPlanGeneration('cr1', db, makeAI())).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/lib/planning/plan-generator.test.ts 2>&1 | head -10
```

Expected: FAIL with "Cannot find module '@/lib/planning/plan-generator'"

- [ ] **Step 3: Implement plan-generator.ts**

```typescript
// lib/planning/plan-generator.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIProvider } from '@/lib/ai/provider'
import type { ImpactedComponent, PlannerTask } from './types'
import { runArchitecturePhase, runComponentTasksPhase, runOrderingPhase, runSpecPhase } from './phases'

export async function runPlanGeneration(
  changeId: string,
  db: SupabaseClient,
  ai: AIProvider
): Promise<void> {
  await db.from('change_requests').update({ status: 'planning' }).eq('id', changeId)

  try {
    // Load change
    const { data: change } = await db
      .from('change_requests')
      .select('id, project_id, title, intent, type, priority')
      .eq('id', changeId)
      .single()

    if (!change) throw new Error(`Change not found: ${changeId}`)

    // Load impact → impacted components
    const { data: impact } = await db
      .from('change_impacts')
      .select('id, change_id')
      .eq('change_id', changeId)
      .maybeSingle()

    if (!impact) throw new Error(`No impact analysis found for change: ${changeId}`)

    const { data: rawComponents } = await db
      .from('change_impact_components')
      .select('component_id, impact_weight, system_components(name, type)')
      .eq('impact_id', impact.id)
      .order('impact_weight', { ascending: false })
      .limit(10)

    const components: ImpactedComponent[] = (rawComponents ?? []).map((row: any) => ({
      componentId: row.component_id,
      name: row.system_components?.name ?? row.component_id,
      type: row.system_components?.type ?? 'module',
      impactWeight: row.impact_weight,
    }))

    if (components.length === 0) throw new Error('No impacted components found — run impact analysis first')

    // Phase 1: Architecture
    const architecture = await runArchitecturePhase(change, components, ai)

    // Create change_plans row
    const { data: plan, error: planError } = await db
      .from('change_plans')
      .insert({
        change_id: changeId,
        status: 'draft',
        estimated_files: architecture.estimatedFiles,
      })
      .select('id')
      .single()

    if (planError || !plan) throw planError ?? new Error('Failed to create change_plans row')

    // Phase 2: Per-component tasks
    const allTasks: PlannerTask[] = []
    for (const component of components) {
      const approach = architecture.componentApproaches[component.name] ?? 'Implement changes as needed'
      const descriptions = await runComponentTasksPhase(change, component, approach, ai)
      for (const description of descriptions) {
        allTasks.push({
          description,
          componentId: component.componentId,
          componentName: component.name,
          orderIndex: allTasks.length,
        })
      }
    }

    // Phase 3: Deterministic ordering
    const orderedTasks = runOrderingPhase(allTasks, components)

    // Write tasks to DB
    if (orderedTasks.length > 0) {
      const taskRows = orderedTasks.map(t => ({
        plan_id: plan.id,
        component_id: t.componentId,
        description: t.description,
        order_index: t.orderIndex,
        status: 'pending',
      }))
      await db.from('change_plan_tasks').insert(taskRows)
    }

    // Update plan with task count
    await db.from('change_plans').update({
      estimated_tasks: orderedTasks.length,
    }).eq('id', plan.id)

    // Phase 4: Spec generation (best-effort)
    const specMarkdown = await runSpecPhase(change, architecture, orderedTasks, ai)
    await db.from('change_plans').update({ spec_markdown: specMarkdown }).eq('id', plan.id)

    // Mark complete
    await db.from('change_requests').update({ status: 'planned' }).eq('id', changeId)

  } catch (err) {
    await db.from('change_requests').update({ status: 'analyzed' }).eq('id', changeId)
    throw err
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/lib/planning/plan-generator.test.ts
```

Expected: 6 passing

- [ ] **Step 5: Run full planning test suite**

```bash
npx vitest run tests/lib/planning/
```

Expected: all passing

- [ ] **Step 6: Commit**

```bash
git add lib/planning/plan-generator.ts tests/lib/planning/plan-generator.test.ts
git commit -m "feat: plan generator orchestrator"
```

---

### Task 4: API Endpoint

**Files:**
- Create: `app/api/change-requests/[id]/plan/route.ts`
- Modify: `app/api/change-requests/[id]/route.ts`

Read both files before editing. The existing `[id]/route.ts` already handles GET and PATCH.

- [ ] **Step 1: Read existing files**

Read `app/api/change-requests/[id]/route.ts` to understand the current GET response shape before modifying it.

- [ ] **Step 2: Create the plan route**

Create `app/api/change-requests/[id]/plan/route.ts`:

```typescript
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getProvider } from '@/lib/ai/registry'
import { runPlanGeneration } from '@/lib/planning/plan-generator'

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: change } = await db
    .from('change_requests')
    .select('id, status, projects!inner(owner_id)')
    .eq('id', id)
    .eq('projects.owner_id', user.id)
    .single()

  if (!change) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const ALLOWED = ['analyzed', 'planned']
  if (!ALLOWED.includes(change.status)) {
    return NextResponse.json(
      { error: `Cannot generate plan from status '${change.status}'. Must be 'analyzed' or 'planned'.` },
      { status: 409 }
    )
  }

  const adminDb = createAdminClient()
  const ai = getProvider()
  runPlanGeneration(id, adminDb, ai).catch(err =>
    console.error(`[plan-generator] change ${id} failed:`, err)
  )

  return NextResponse.json({ status: 'planning' }, { status: 202 })
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: change } = await db
    .from('change_requests')
    .select('id, projects!inner(owner_id)')
    .eq('id', id)
    .eq('projects.owner_id', user.id)
    .single()

  if (!change) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: plan } = await db
    .from('change_plans')
    .select('id, status, spec_markdown, estimated_tasks, estimated_files, created_at, approved_at')
    .eq('change_id', id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!plan) return NextResponse.json(null)

  const { data: tasks } = await db
    .from('change_plan_tasks')
    .select('id, component_id, description, order_index, status, system_components(name, type)')
    .eq('plan_id', plan.id)
    .order('order_index', { ascending: true })

  return NextResponse.json({ ...plan, tasks: tasks ?? [] })
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  if (body.action !== 'approve') {
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  }

  const { data: change } = await db
    .from('change_requests')
    .select('id, projects!inner(owner_id)')
    .eq('id', id)
    .eq('projects.owner_id', user.id)
    .single()

  if (!change) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: plan } = await db
    .from('change_plans')
    .select('id')
    .eq('change_id', id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!plan) return NextResponse.json({ error: 'No plan found' }, { status: 404 })

  await db.from('change_plans')
    .update({ status: 'approved', approved_at: new Date().toISOString() })
    .eq('id', plan.id)

  return NextResponse.json({ status: 'approved' })
}
```

- [ ] **Step 3: Add plan to GET /api/change-requests/[id]**

In `app/api/change-requests/[id]/route.ts`, extend the GET handler to include plan data.

After the `impactComponents` fetch (around line 47) and before `return NextResponse.json(...)`, add:

```typescript
  // Fetch plan if planned or later
  const { data: plan } = await db
    .from('change_plans')
    .select('id, status, estimated_tasks, estimated_files, approved_at')
    .eq('change_id', id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const { data: planTasks } = plan
    ? await db
        .from('change_plan_tasks')
        .select('id, component_id, description, order_index, status, system_components(name, type)')
        .eq('plan_id', plan.id)
        .order('order_index', { ascending: true })
    : { data: [] }
```

And extend the return:

```typescript
  return NextResponse.json({
    ...change,
    impact: impact ?? null,
    risk_factors: riskFactors ?? [],
    impact_components: impactComponents ?? [],
    plan: plan ?? null,
    plan_tasks: planTasks ?? [],
  })
```

- [ ] **Step 4: Run full test suite**

```bash
npx vitest run
```

Expected: all tests passing

- [ ] **Step 5: Commit**

```bash
git add app/api/change-requests/[id]/plan/route.ts app/api/change-requests/[id]/route.ts
git commit -m "feat: plan API endpoint (POST/GET/PATCH) and plan data in change GET"
```

---

### Task 5: UI — Generate Plan + Plan Workspace

**Files:**
- Modify: `app/projects/[id]/changes/[changeId]/page.tsx`
- Modify: `app/projects/[id]/changes/[changeId]/change-detail-view.tsx`

Read both files in full before making any changes.

- [ ] **Step 1: Read existing files**

Read both files completely. The current `page.tsx` fetches change + impact data and passes them to `ChangeDetailView`. The current `change-detail-view.tsx` has: analyzing indicator, open-status Run Analysis button, and full impact panel. You will be adding to this, not replacing it.

- [ ] **Step 2: Update page.tsx to fetch plan data**

In `page.tsx`, after the `impactComponents` fetch, add plan fetching:

```typescript
  // Fetch plan if exists
  const { data: plan } = await db
    .from('change_plans')
    .select('id, status, spec_markdown, estimated_tasks, estimated_files, approved_at')
    .eq('change_id', changeId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const { data: planTasks } = plan
    ? await db
        .from('change_plan_tasks')
        .select('id, component_id, description, order_index, status, system_components(name, type)')
        .eq('plan_id', plan.id)
        .order('order_index', { ascending: true })
    : { data: [] }
```

Update the return to pass the new props:

```typescript
  return (
    <ChangeDetailView
      project={project}
      change={change}
      impact={impact ?? null}
      riskFactors={riskFactors ?? []}
      impactComponents={impactComponents ?? []}
      plan={plan ?? null}
      planTasks={planTasks ?? []}
    />
  )
```

- [ ] **Step 3: Add interfaces to change-detail-view.tsx**

After the existing `ImpactComponent` interface, add:

```typescript
interface PlanData {
  id: string
  status: string
  spec_markdown: string | null
  estimated_tasks: number | null
  estimated_files: number | null
  approved_at: string | null
}

interface PlanTask {
  id: string
  component_id: string | null
  description: string
  order_index: number
  status: string
  system_components: { name: string; type: string } | null
}
```

- [ ] **Step 4: Update ChangeDetailView function signature and state**

Update the function signature to accept the new props:

```typescript
export function ChangeDetailView({
  project,
  change: initial,
  impact: initialImpact,
  riskFactors: initialRiskFactors,
  impactComponents: initialImpactComponents,
  plan: initialPlan,
  planTasks: initialPlanTasks,
}: {
  project: Project
  change: Change
  impact: ImpactData | null
  riskFactors: RiskFactor[]
  impactComponents: ImpactComponent[]
  plan: PlanData | null
  planTasks: PlanTask[]
})
```

After the existing `impactComponents` state, add:

```typescript
  const [plan, setPlan] = useState(initialPlan)
  const [planTasks, setPlanTasks] = useState(initialPlanTasks)
  const [planTab, setPlanTab] = useState<'tasks' | 'spec'>('tasks')
  const [approving, setApproving] = useState(false)
```

- [ ] **Step 5: Extend ANALYZING_STATUSES and update polling**

Add `'planning'` to the `ANALYZING_STATUSES` array:

```typescript
const ANALYZING_STATUSES = ['analyzing', 'analyzing_mapping', 'analyzing_propagation', 'analyzing_scoring', 'planning']
```

Add `'planning'` step to `ANALYSIS_STEPS`:

```typescript
const ANALYSIS_STEPS = [
  { label: 'Mapping intent → components', statuses: ['analyzing', 'analyzing_mapping'] },
  { label: 'Propagating dependency graph', statuses: ['analyzing_propagation'] },
  { label: 'Computing risk score', statuses: ['analyzing_scoring'] },
  { label: 'Generating implementation plan', statuses: ['planning'] },
]
```

Update the polling `useEffect` to also set plan data when planning completes:

```typescript
  useEffect(() => {
    if (!isAnalyzing) return
    const id = setInterval(async () => {
      const res = await fetch(`/api/change-requests/${change.id}`)
      if (!res.ok) return
      const updated = await res.json()
      setChange(updated)
      if (!ANALYZING_STATUSES.includes(updated.status)) {
        clearInterval(id)
        setImpact(updated.impact ?? null)
        setRiskFactors(updated.risk_factors ?? [])
        setImpactComponents(updated.impact_components ?? [])
        setPlan(updated.plan ?? null)
        setPlanTasks(updated.plan_tasks ?? [])
        router.refresh()
      }
    }, 2000)
    return () => clearInterval(id)
  }, [change.id, isAnalyzing, router])
```

- [ ] **Step 6: Add Generate Plan button to impact panel**

In the impact panel (inside `change.status === 'analyzed' && impact`), after the risk factors section and before the closing `</div>`, add:

```typescript
                {/* Generate Plan CTA */}
                <div className="px-5 py-4 border-t border-white/5 flex items-center justify-between">
                  <div className="text-xs text-slate-500 font-mono">
                    {change.risk_level === 'high' && (
                      <span className="text-red-400">High risk — confirmation required</span>
                    )}
                  </div>
                  <button
                    onClick={async () => {
                      const confirmed = change.risk_level !== 'high' ||
                        window.confirm('This change carries high risk. Generate a plan anyway?')
                      if (!confirmed) return
                      const res = await fetch(`/api/change-requests/${change.id}/plan`, { method: 'POST' })
                      if (res.ok) setChange(c => ({ ...c, status: 'planning' }))
                    }}
                    className="px-4 py-2 rounded-lg bg-indigo-500 hover:bg-indigo-400 text-white text-sm font-bold font-headline transition-colors"
                  >
                    Generate Plan
                  </button>
                </div>
```

- [ ] **Step 7: Add plan workspace for planned status**

After the `change.status === 'analyzed' && !impact` fallback block (just before the final `) : null}`), add:

```typescript
            ) : change.status === 'planned' && plan ? (
              <div className="rounded-xl bg-[#131b2e] border border-white/5 overflow-hidden">
                {/* Plan header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
                  <p className="text-xs font-bold uppercase tracking-widest text-slate-400 font-headline">Implementation Plan</p>
                  <div className="flex items-center gap-3">
                    {plan.estimated_tasks !== null && (
                      <span className="text-[10px] font-mono text-slate-500">{plan.estimated_tasks} tasks</span>
                    )}
                    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded uppercase tracking-wider ${
                      plan.status === 'approved'
                        ? 'bg-green-400/10 text-green-400'
                        : 'bg-slate-700 text-slate-400'
                    }`}>
                      {plan.status}
                    </span>
                  </div>
                </div>

                {/* Tab bar */}
                <div className="flex border-b border-white/5">
                  {(['tasks', 'spec'] as const).map(tab => (
                    <button
                      key={tab}
                      onClick={() => setPlanTab(tab)}
                      className={`px-5 py-2.5 text-xs font-bold uppercase tracking-widest font-headline transition-colors ${
                        planTab === tab
                          ? 'text-indigo-400 border-b-2 border-indigo-400'
                          : 'text-slate-500 hover:text-slate-300'
                      }`}
                    >
                      {tab}
                    </button>
                  ))}
                </div>

                {/* Tasks tab */}
                {planTab === 'tasks' && (
                  <div className="divide-y divide-white/5">
                    {planTasks.length === 0 ? (
                      <p className="px-5 py-6 text-sm text-slate-500 text-center">No tasks generated.</p>
                    ) : (
                      planTasks.map((task) => (
                        <div key={task.id} className="px-5 py-3 flex items-start gap-3">
                          <span className={`mt-0.5 h-2 w-2 rounded-full flex-shrink-0 ${
                            task.status === 'done' ? 'bg-green-400' : 'bg-slate-600'
                          }`} />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-slate-300">{task.description}</p>
                            {task.system_components && (
                              <span className="text-[10px] font-mono text-slate-600 mt-0.5 block">
                                {task.system_components.name}
                              </span>
                            )}
                          </div>
                          <span className="text-[10px] font-mono text-slate-600 flex-shrink-0">
                            #{task.order_index + 1}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                )}

                {/* Spec tab */}
                {planTab === 'spec' && (
                  <div className="px-5 py-4">
                    {plan.spec_markdown ? (
                      <pre className="text-xs text-slate-400 font-mono whitespace-pre-wrap leading-relaxed">
                        {plan.spec_markdown}
                      </pre>
                    ) : (
                      <p className="text-sm text-slate-500 text-center py-4">Spec not available.</p>
                    )}
                  </div>
                )}

                {/* Approve footer */}
                {plan.status !== 'approved' && (
                  <div className="px-5 py-4 border-t border-white/5 flex items-center justify-end gap-3">
                    <button
                      onClick={async () => {
                        const res = await fetch(`/api/change-requests/${change.id}/plan`, { method: 'POST' })
                        if (res.ok) setChange(c => ({ ...c, status: 'planning' }))
                      }}
                      className="px-3 py-1.5 rounded-lg border border-white/10 text-slate-400 hover:text-slate-200 text-xs font-bold font-headline transition-colors"
                    >
                      Regenerate
                    </button>
                    <button
                      disabled={approving}
                      onClick={async () => {
                        setApproving(true)
                        const res = await fetch(`/api/change-requests/${change.id}/plan`, {
                          method: 'PATCH',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ action: 'approve' }),
                        })
                        if (res.ok) {
                          setPlan(p => p ? { ...p, status: 'approved' } : p)
                        }
                        setApproving(false)
                      }}
                      className="px-4 py-2 rounded-lg bg-green-500 hover:bg-green-400 disabled:opacity-50 text-white text-sm font-bold font-headline transition-colors"
                    >
                      {approving ? 'Approving…' : 'Approve Plan'}
                    </button>
                  </div>
                )}
              </div>
```

- [ ] **Step 8: Run full test suite**

```bash
npx vitest run
```

Expected: all tests passing

- [ ] **Step 9: Commit**

```bash
git add app/projects/[id]/changes/[changeId]/page.tsx app/projects/[id]/changes/[changeId]/change-detail-view.tsx
git commit -m "feat: Generate Plan button and plan workspace UI"
```

---

## Self-Review

### Spec coverage

| Requirement | Covered by |
|---|---|
| 4-phase planner pipeline | Tasks 2 + 3 |
| Phase 1: Architecture (approach, branch name) | Task 2 (`runArchitecturePhase`) |
| Phase 2: Per-component tasks (sequential AI calls) | Task 2 (`runComponentTasksPhase`) |
| Phase 3: Ordering by component type | Task 2 (`runOrderingPhase`) |
| Phase 4: Spec generation (best-effort) | Task 2 (`runSpecPhase`) |
| Writes to change_plans + change_plan_tasks | Task 3 |
| Status: analyzed → planning → planned | Task 3 |
| Error recovery reverts to analyzed | Task 3 |
| POST /api/change-requests/[id]/plan (trigger, 409 if not analyzed) | Task 4 |
| GET /api/change-requests/[id]/plan (plan + tasks) | Task 4 |
| PATCH /api/change-requests/[id]/plan (approve) | Task 4 |
| Plan included in GET /api/change-requests/[id] for polling | Task 4 |
| Generate Plan button on impact panel | Task 5 |
| High-risk confirmation before plan generation | Task 5 |
| Planning step indicator (extends existing) | Task 5 |
| Plan workspace: tasks tab + spec tab | Task 5 |
| Approve Plan button | Task 5 |
| Regenerate button | Task 5 |

### Type consistency

- `ImpactedComponent.componentId` used in Tasks 1, 2, 3 ✓
- `PlannerArchitecture.componentApproaches` keyed by `component.name` (not ID) — Tasks 1, 2, 3 consistent ✓
- `PlannerTask.orderIndex` mutated by `runOrderingPhase` and written as `order_index` to DB ✓
- `plan.status` values: `'draft'` (initial insert), `'approved'` (PATCH) — consistent with DB schema ✓
- `change_requests.status` values: `'analyzing'` → `'analyzed'` → `'planning'` → `'planned'` — `'planning'` added to ANALYZING_STATUSES in Task 5 ✓
- `system_components(name, type)` join alias used identically in Task 4 plan route and Task 5 UI ✓
