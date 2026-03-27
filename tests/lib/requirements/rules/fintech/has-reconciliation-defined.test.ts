import { describe, it, expect } from 'vitest'
import { hasReconciliationDefined } from '@/lib/requirements/rules/fintech/has-reconciliation-defined'
import type { ParsedItem } from '@/lib/requirements/parser'

const base: ParsedItem = { type: 'functional', title: 'x', description: 'x', priority: 'low', source_text: null, nfr_category: null }

describe('hasReconciliationDefined', () => {
  it('returns false when no reconciliation keywords present', () => {
    expect(hasReconciliationDefined([{ ...base, description: 'Users place orders.' }])).toBe(false)
  })
  it('returns true when reconciliation is mentioned', () => {
    expect(hasReconciliationDefined([{ ...base, description: 'Daily reconciliation verifies account balances.' }])).toBe(true)
  })
  it('returns true when balance check is in description', () => {
    expect(hasReconciliationDefined([{ ...base, description: 'Balance checks run after each settlement.' }])).toBe(true)
  })
})
