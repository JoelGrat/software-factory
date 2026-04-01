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
  it('transitions status: planning → planned in correct order', async () => {
    const { db, updates } = makeMockDb()
    const ai = makeAI()

    await runPlanGeneration('cr1', db, ai)

    const statuses = updates
      .filter(u => u.table === 'change_requests' && u.data.status)
      .map(u => u.data.status)

    expect(statuses.indexOf('planning')).toBeLessThan(statuses.indexOf('planned'))
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
    // Set spec response only when "Spec" or markdown prompt is detected
    ai.setResponse('Spec', '# Spec\n\nDo the work.')

    await runPlanGeneration('cr1', db, ai)

    const planUpdate = updates.find(u => u.table === 'change_plans' && u.data.spec_markdown !== undefined)
    expect(planUpdate).toBeDefined()
  })

  it('throws and re-throws on missing change', async () => {
    const { db } = makeMockDb({ change: null })
    await expect(runPlanGeneration('cr1', db, makeAI())).rejects.toThrow()
  })
})
