import { describe, it, expect, vi } from 'vitest'
import { runImpactAnalysis } from '@/lib/impact/impact-analyzer'
import { MockAIProvider } from '@/lib/ai/adapters/mock'
import type { SupabaseClient } from '@supabase/supabase-js'

type UpdateCapture = { table: string; data: Record<string, unknown>; eq: string }
type InsertCapture = { table: string; data: Record<string, unknown> | Array<Record<string, unknown>> }

function makeMockDb(opts: {
  change?: Record<string, unknown>
  components?: Array<{ id: string; name: string; type: string; has_unknown_dependencies: boolean; avg_confidence: number }>
  edges?: Array<{ from_file_id: string; to_file_id: string; edge_type: string }>
  assignments?: Array<{ file_id: string; component_id: string }>
} = {}): { db: SupabaseClient; updates: UpdateCapture[]; inserts: InsertCapture[] } {
  const updates: UpdateCapture[] = []
  const inserts: InsertCapture[] = []

  const change = opts.change !== undefined ? opts.change : {
    id: 'cr1', project_id: 'proj1', title: 'Fix auth', intent: 'Auth is broken', tags: []
  }
  const components = opts.components ?? [
    { id: 'comp-auth', name: 'AuthService', type: 'auth', has_unknown_dependencies: false, avg_confidence: 80 }
  ]
  const edges = opts.edges ?? []
  const assignments = opts.assignments ?? [
    { file_id: 'file-auth-1', component_id: 'comp-auth' }
  ]

  const db = {
    from: (table: string) => {
      if (table === 'change_requests') {
        return {
          update: (data: Record<string, unknown>) => ({
            eq: (col: string, val: string) => {
              updates.push({ table, data, eq: `${col}=${val}` })
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
      if (table === 'system_components') {
        return {
          select: () => ({
            eq: () => ({
              is: () => ({
                order: () => Promise.resolve({ data: components, error: null }),
              }),
            }),
          }),
          // For the in() query to get component details by IDs
          _selectWithIn: () => ({
            in: () => Promise.resolve({ data: components, error: null }),
          }),
        }
      }
      if (table === 'component_graph_edges') {
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: edges, error: null }),
          }),
        }
      }
      if (table === 'component_assignment') {
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: assignments, error: null }),
            in: () => Promise.resolve({ data: assignments, error: null }),
          }),
        }
      }
      if (table === 'change_impacts') {
        return {
          insert: (data: Record<string, unknown>) => ({
            select: () => ({
              single: () => {
                inserts.push({ table, data })
                return Promise.resolve({ data: { id: 'impact-1' }, error: null })
              },
            }),
          }),
          delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
        }
      }
      if (table === 'change_risk_factors') {
        return {
          insert: (data: unknown) => {
            inserts.push({ table, data: data as Record<string, unknown> })
            return Promise.resolve({ error: null })
          },
          delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
        }
      }
      if (table === 'change_impact_components') {
        return {
          insert: (data: unknown) => {
            inserts.push({ table, data: data as Array<Record<string, unknown>> })
            return Promise.resolve({ error: null })
          },
        }
      }
      return {
        select: () => ({ eq: () => ({ in: () => Promise.resolve({ data: [], error: null }), single: () => Promise.resolve({ data: null, error: null }) }) }),
        update: (data: Record<string, unknown>) => ({ eq: (col: string, val: string) => { updates.push({ table, data, eq: `${col}=${val}` }); return Promise.resolve({ error: null }) } }),
        insert: (data: unknown) => { inserts.push({ table, data: data as Record<string, unknown> }); return Promise.resolve({ error: null }) },
        delete: () => ({ eq: () => Promise.resolve({ error: null }), is: () => Promise.resolve({ error: null }) }),
      }
    },
  } as unknown as SupabaseClient

  // Patch system_components to handle .in() chain
  const originalFrom = db.from.bind(db)
  ;(db as any).from = (table: string) => {
    const base = originalFrom(table)
    if (table === 'system_components') {
      return {
        ...base,
        select: (cols: string) => {
          const chain = (base as any).select(cols)
          return {
            ...chain,
            in: () => Promise.resolve({ data: components, error: null }),
            eq: chain.eq,
          }
        },
      }
    }
    return base
  }

  return { db, updates, inserts }
}

describe('runImpactAnalysis', () => {
  it('transitions through all analyzing statuses then analyzed', async () => {
    const { db, updates } = makeMockDb()
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({ affected: [] }))

    await runImpactAnalysis('cr1', db, ai)

    const statusUpdates = updates
      .filter(u => u.table === 'change_requests' && u.data.status)
      .map(u => u.data.status)

    expect(statusUpdates).toContain('analyzing_mapping')
    expect(statusUpdates).toContain('analyzing_propagation')
    expect(statusUpdates).toContain('analyzing_scoring')
    expect(statusUpdates).toContain('analyzed')
  })

  it('inserts a change_impacts row', async () => {
    const { db, inserts } = makeMockDb()
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({ affected: [] }))

    await runImpactAnalysis('cr1', db, ai)

    expect(inserts.some(i => i.table === 'change_impacts')).toBe(true)
  })

  it('inserts change_impact_components for mapped components', async () => {
    const { db, inserts } = makeMockDb()
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({ affected: [] }))

    await runImpactAnalysis('cr1', db, ai)

    expect(inserts.some(i => i.table === 'change_impact_components')).toBe(true)
  })

  it('sets status back to open on failure', async () => {
    // Make change_requests select fail after status update
    const { db, updates } = makeMockDb({ change: null as any })
    const ai = new MockAIProvider()

    // change is null → should throw inside and recover
    await expect(runImpactAnalysis('cr1', db, ai)).rejects.toThrow()

    const finalStatus = updates
      .filter(u => u.table === 'change_requests')
      .map(u => u.data.status)
      .at(-1)

    expect(finalStatus).toBe('open')
  })

  it('sets risk_level on the change_request after analysis', async () => {
    const { db, updates } = makeMockDb()
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({ affected: [] }))

    await runImpactAnalysis('cr1', db, ai)

    const finalUpdate = updates
      .filter(u => u.table === 'change_requests' && u.data.risk_level)
      .at(-1)

    expect(['low', 'medium', 'high']).toContain(finalUpdate?.data.risk_level)
  })
})
