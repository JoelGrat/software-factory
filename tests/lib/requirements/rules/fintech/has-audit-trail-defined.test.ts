import { describe, it, expect } from 'vitest'
import { hasAuditTrailDefined } from '@/lib/requirements/rules/fintech/has-audit-trail-defined'
import type { ParsedItem } from '@/lib/requirements/parser'

const base: ParsedItem = { type: 'functional', title: 'x', description: 'x', priority: 'low', source_text: null, nfr_category: null }

describe('hasAuditTrailDefined', () => {
  it('returns false when no audit keywords present', () => {
    expect(hasAuditTrailDefined([{ ...base, description: 'Users create accounts.' }])).toBe(false)
  })
  it('returns true when audit trail is mentioned', () => {
    expect(hasAuditTrailDefined([{ ...base, description: 'Every transaction is recorded in the audit trail.' }])).toBe(true)
  })
  it('returns true when transaction log is in title', () => {
    expect(hasAuditTrailDefined([{ ...base, title: 'Transaction log for all financial events' }])).toBe(true)
  })
})
