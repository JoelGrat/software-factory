// tests/lib/execution/test-selector.test.ts
import { describe, it, expect } from 'vitest'
import { selectTests } from '@/lib/execution/test-selector'
import type { SupabaseClient } from '@supabase/supabase-js'

function makeMockDb(testPaths: string[]): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        in: () => Promise.resolve({
          data: testPaths.map(tp => ({ test_path: tp })),
          error: null,
        }),
      }),
    }),
  } as unknown as SupabaseClient
}

describe('selectTests', () => {
  it('returns direct tests for changed file IDs', async () => {
    const db = makeMockDb(['tests/user.test.ts', 'tests/auth.test.ts'])
    const scope = await selectTests(db, ['file-1', 'file-2'], 'low')
    expect(scope.directTests).toContain('tests/user.test.ts')
    expect(scope.widened).toBe(false)
  })

  it('sets widened=true for high risk', async () => {
    const db = makeMockDb(['tests/user.test.ts'])
    const scope = await selectTests(db, ['file-1'], 'high')
    expect(scope.widened).toBe(true)
  })

  it('deduplicates across directTests', async () => {
    const db = makeMockDb(['tests/user.test.ts', 'tests/user.test.ts'])
    const scope = await selectTests(db, ['file-1'], 'low')
    const count = scope.directTests.filter(t => t === 'tests/user.test.ts').length
    expect(count).toBe(1)
  })

  it('returns empty arrays when no tests mapped', async () => {
    const db = makeMockDb([])
    const scope = await selectTests(db, ['file-1'], 'low')
    expect(scope.directTests).toEqual([])
    expect(scope.dependentTests).toEqual([])
  })
})
