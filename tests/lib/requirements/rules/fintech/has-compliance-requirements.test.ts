import { describe, it, expect } from 'vitest'
import { hasComplianceRequirements } from '@/lib/requirements/rules/fintech/has-compliance-requirements'
import type { ParsedItem } from '@/lib/requirements/parser'

const base: ParsedItem = { type: 'functional', title: 'x', description: 'x', priority: 'low', source_text: null, nfr_category: null }

describe('hasComplianceRequirements', () => {
  it('returns false when no compliance keywords present', () => {
    expect(hasComplianceRequirements([{ ...base, description: 'Users submit payment forms.' }])).toBe(false)
  })
  it('returns true when regulatory compliance is mentioned', () => {
    expect(hasComplianceRequirements([{ ...base, description: 'The system must comply with PCI-DSS regulations.' }])).toBe(true)
  })
  it('returns true when GDPR is mentioned in title', () => {
    expect(hasComplianceRequirements([{ ...base, title: 'GDPR data retention policy' }])).toBe(true)
  })
})
