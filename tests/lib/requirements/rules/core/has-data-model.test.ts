import { describe, it, expect } from 'vitest'
import { hasDataModelDefined } from '@/lib/requirements/rules/core/has-data-model'
import type { ParsedItem } from '@/lib/requirements/parser'

const base: ParsedItem = {
  type: 'functional', title: 'x', description: 'x', priority: 'low', source_text: null, nfr_category: null,
}

describe('hasDataModelDefined', () => {
  it('returns false when no data model keywords present', () => {
    expect(hasDataModelDefined([{ ...base, description: 'The system processes the form.' }])).toBe(false)
  })
  it('returns true when description mentions entity', () => {
    expect(hasDataModelDefined([{ ...base, description: 'The User entity has name and email fields.' }])).toBe(true)
  })
  it('returns true when title mentions schema', () => {
    expect(hasDataModelDefined([{ ...base, title: 'Database schema for orders' }])).toBe(true)
  })
  it('returns true when description mentions data structure', () => {
    expect(hasDataModelDefined([{ ...base, description: 'Define the data structure for invoice records.' }])).toBe(true)
  })
})
