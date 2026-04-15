import { describe, it, expect } from 'vitest'
import { runPipeline } from '@/lib/pipeline/orchestrator'

// Minimal DB that returns null for every query (simulates change not found)
const nullDb = {
  from: () => ({
    select: () => ({
      eq: () => ({
        single: async () => ({ data: null, error: null }),
        order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null }) }) }),
        maybeSingle: async () => ({ data: null }),
        eq: () => ({
          select: () => ({ data: [] }),
          single: async () => ({ data: null, error: null }),
        }),
      }),
    }),
    update: () => ({ eq: () => ({ eq: () => ({ select: () => ({ data: [] }) }), select: () => ({ data: [] }) }) }),
    insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { message: 'mock' } }) }) }),
    delete: () => ({ eq: () => ({}) }),
  }),
} as any

describe('runPipeline', () => {
  it('throws when change is not found', async () => {
    await expect(runPipeline('nonexistent-id', nullDb, {} as any))
      .rejects.toThrow('Change not found')
  })
})
