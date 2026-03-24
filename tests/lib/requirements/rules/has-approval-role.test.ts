import { describe, it, expect } from 'vitest'
import { hasApprovalRole } from '@/lib/requirements/rules/has-approval-role'
import type { ParsedItem } from '@/lib/requirements/parser'

const base: ParsedItem = {
  type: 'functional', title: 'x', description: 'x', priority: 'low', source_text: 'x', nfr_category: null,
}

describe('hasApprovalRole', () => {
  it('returns false when no items mention approval', () => {
    expect(hasApprovalRole([{ ...base, description: 'User can submit a form.' }])).toBe(false)
  })
  it('returns true when an item mentions approval', () => {
    expect(hasApprovalRole([{ ...base, description: 'A manager must approve all requests.' }])).toBe(true)
  })
  it('returns true for sign-off keyword', () => {
    expect(hasApprovalRole([{ ...base, title: 'Sign-off by finance lead' }])).toBe(true)
  })
  it('returns false for empty items array', () => {
    expect(hasApprovalRole([])).toBe(false)
  })
})
