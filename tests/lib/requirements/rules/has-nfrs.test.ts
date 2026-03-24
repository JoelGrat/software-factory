import { describe, it, expect } from 'vitest'
import { hasNonFunctionalRequirements } from '@/lib/requirements/rules/has-nfrs'
import type { ParsedItem } from '@/lib/requirements/parser'

const base: ParsedItem = {
  type: 'functional', title: 'x', description: 'x', priority: 'low', source_text: 'x', nfr_category: null,
}

describe('hasNonFunctionalRequirements', () => {
  it('returns false when all items are functional', () => {
    expect(hasNonFunctionalRequirements([base])).toBe(false)
  })
  it('returns true when at least one non-functional item exists', () => {
    const nfr: ParsedItem = { ...base, type: 'non-functional', nfr_category: 'performance' }
    expect(hasNonFunctionalRequirements([base, nfr])).toBe(true)
  })
})
