import { describe, it, expect } from 'vitest'
import { hasMultiTenancyAddressed } from '@/lib/requirements/rules/saas/has-multi-tenancy-addressed'
import type { ParsedItem } from '@/lib/requirements/parser'

const base: ParsedItem = { type: 'functional', title: 'x', description: 'x', priority: 'low', source_text: null, nfr_category: null }

describe('hasMultiTenancyAddressed', () => {
  it('returns false when no tenancy keywords present', () => {
    expect(hasMultiTenancyAddressed([{ ...base, description: 'Users can create orders.' }])).toBe(false)
  })
  it('returns true when tenant isolation is mentioned', () => {
    expect(hasMultiTenancyAddressed([{ ...base, description: 'Each tenant has isolated data storage.' }])).toBe(true)
  })
  it('returns true when organisation workspace is mentioned', () => {
    expect(hasMultiTenancyAddressed([{ ...base, description: 'Users belong to an organisation workspace.' }])).toBe(true)
  })
})
