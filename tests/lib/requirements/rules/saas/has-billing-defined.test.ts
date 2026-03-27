import { describe, it, expect } from 'vitest'
import { hasBillingDefined } from '@/lib/requirements/rules/saas/has-billing-defined'
import type { ParsedItem } from '@/lib/requirements/parser'

const base: ParsedItem = { type: 'functional', title: 'x', description: 'x', priority: 'low', source_text: null, nfr_category: null }

describe('hasBillingDefined', () => {
  it('returns false when no billing keywords present', () => {
    expect(hasBillingDefined([{ ...base, description: 'Users can log in.' }])).toBe(false)
  })
  it('returns true when subscription is mentioned', () => {
    expect(hasBillingDefined([{ ...base, description: 'Users can choose a monthly subscription plan.' }])).toBe(true)
  })
  it('returns true when payment is in the title', () => {
    expect(hasBillingDefined([{ ...base, title: 'Payment processing flow' }])).toBe(true)
  })
})
