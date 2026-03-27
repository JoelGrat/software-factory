import { describe, it, expect } from 'vitest'
import { hasAuthStrategyDefined } from '@/lib/requirements/rules/saas/has-auth-strategy-defined'
import type { ParsedItem } from '@/lib/requirements/parser'

const base: ParsedItem = { type: 'functional', title: 'x', description: 'x', priority: 'low', source_text: null, nfr_category: null }

describe('hasAuthStrategyDefined', () => {
  it('returns false when no auth keywords present', () => {
    expect(hasAuthStrategyDefined([{ ...base, description: 'The system exports a CSV report.' }])).toBe(false)
  })
  it('returns true when authentication is mentioned', () => {
    expect(hasAuthStrategyDefined([{ ...base, description: 'Authentication uses JWT tokens.' }])).toBe(true)
  })
  it('returns true when login is mentioned', () => {
    expect(hasAuthStrategyDefined([{ ...base, description: 'Users log in with email and password.' }])).toBe(true)
  })
})
