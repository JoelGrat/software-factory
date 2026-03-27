import { describe, it, expect } from 'vitest'
import { hasEdgeCasesCovered } from '@/lib/requirements/rules/core/has-edge-cases-covered'
import type { ParsedItem } from '@/lib/requirements/parser'

const base: ParsedItem = {
  type: 'functional', title: 'x', description: 'x', priority: 'low', source_text: null, nfr_category: null,
}

describe('hasEdgeCasesCovered', () => {
  it('returns false when no edge case keywords present', () => {
    expect(hasEdgeCasesCovered([{ ...base, description: 'Users can create orders.' }])).toBe(false)
  })
  it('returns true when description mentions edge case', () => {
    expect(hasEdgeCasesCovered([{ ...base, description: 'Edge cases for empty cart must be handled.' }])).toBe(true)
  })
  it('returns true when description mentions boundary', () => {
    expect(hasEdgeCasesCovered([{ ...base, description: 'The boundary of 1000 items per order is enforced.' }])).toBe(true)
  })
  it('returns true when description mentions null handling', () => {
    expect(hasEdgeCasesCovered([{ ...base, description: 'Null values must return a 400 error.' }])).toBe(true)
  })
})
