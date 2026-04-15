import { describe, it, expect } from 'vitest'
import { inferLikelyFilePaths, deriveAssumptions, generateSpec } from '@/lib/planning/spec-generator'
import { MockAIProvider } from '@/lib/ai/adapters/mock'
import type { SupabaseClient } from '@supabase/supabase-js'

describe('inferLikelyFilePaths', () => {
  it('extracts path-like tokens from intent', () => {
    const paths = inferLikelyFilePaths({
      title: 'Add execution strip',
      intent: 'Create components/app/execution-strip.tsx and update lib/execution/types.ts',
    })
    expect(paths).toContain('components/app/execution-strip.tsx')
    expect(paths).toContain('lib/execution/types.ts')
  })

  it('returns empty array when no paths in intent', () => {
    const paths = inferLikelyFilePaths({ title: 'Refactor auth', intent: 'Improve session handling' })
    expect(paths).toHaveLength(0)
  })

  it('deduplicates paths', () => {
    const paths = inferLikelyFilePaths({
      title: 'Update',
      intent: 'Modify lib/foo.ts and also update lib/foo.ts',
    })
    expect(paths.filter(p => p === 'lib/foo.ts')).toHaveLength(1)
  })
})

describe('deriveAssumptions', () => {
  it('includes additive assumption for feature type', () => {
    const assumptions = deriveAssumptions({ title: 'Add X', intent: 'Add feature', type: 'feature' })
    expect(assumptions.some(a => a.includes('additive'))).toBe(true)
  })

  it('includes migration assumption when intent mentions migrate', () => {
    const assumptions = deriveAssumptions({ title: 'Update schema', intent: 'Need to migrate the DB', type: 'feature' })
    expect(assumptions.some(a => a.toLowerCase().includes('migration'))).toBe(true)
  })

  it('returns empty array for unrecognized signals', () => {
    const assumptions = deriveAssumptions({ title: 'Rename variable', intent: 'Rename foo to bar', type: 'chore' })
    expect(assumptions).toHaveLength(0)
  })
})

const CHANGE_ROW = { id: 'c1', project_id: 'p1', title: 'Fix login', intent: 'Login is broken', type: 'bug' }
const PROJECT_ROW = { name: 'My Project', description: 'A test project' }

const VALID_SPEC_PAYLOAD = {
  problem: 'The login flow is broken',
  goals: ['Restore login', 'Add regression test'],
  architecture: 'Fix the auth handler and add a test',
  constraints: ['Must not change existing API'],
  out_of_scope: ['UI redesign'],
  markdown: '# Spec\n\nFix the login.',
}

function makeMockDb(): SupabaseClient {
  return {
    from: (table: string) => {
      if (table === 'change_requests') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: CHANGE_ROW, error: null }),
            }),
          }),
        }
      }
      if (table === 'projects') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: PROJECT_ROW, error: null }),
            }),
          }),
        }
      }
      if (table === 'system_components') {
        return {
          select: () => ({
            eq: () => ({
              is: () => Promise.resolve({ data: [], error: null }),
            }),
          }),
        }
      }
      return {
        select: () => ({
          eq: () => ({
            single: async () => ({ data: null, error: null }),
            is: () => Promise.resolve({ data: null, error: null }),
          }),
        }),
      }
    },
  } as unknown as SupabaseClient
}

describe('generateSpec', () => {
  it('returns spec and markdown when AI returns valid JSON', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify(VALID_SPEC_PAYLOAD))
    const db = makeMockDb()

    const result = await generateSpec('c1', db, ai)

    expect(result.spec.problem).toBe(VALID_SPEC_PAYLOAD.problem)
    expect(result.spec.goals).toEqual(VALID_SPEC_PAYLOAD.goals)
    expect(result.markdown).toBe(VALID_SPEC_PAYLOAD.markdown)
  })

  it('throws a helpful error when AI returns non-JSON content', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse('Sorry, I cannot help with that.')
    const db = makeMockDb()

    await expect(generateSpec('c1', db, ai)).rejects.toThrow('non-JSON response')
  })
})
