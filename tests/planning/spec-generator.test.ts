import { describe, it, expect } from 'vitest'
import { inferLikelyFilePaths, deriveAssumptions } from '@/lib/planning/spec-generator'

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
