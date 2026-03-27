import { describe, it, expect } from 'vitest'
import { hasRollbackDefined } from '@/lib/requirements/rules/workflow/has-rollback-defined'
import type { ParsedItem } from '@/lib/requirements/parser'

const base: ParsedItem = { type: 'functional', title: 'x', description: 'x', priority: 'low', source_text: null, nfr_category: null }

describe('hasRollbackDefined', () => {
  it('returns false when no rollback keywords present', () => {
    expect(hasRollbackDefined([{ ...base, description: 'The pipeline processes files.' }])).toBe(false)
  })
  it('returns true when rollback is mentioned', () => {
    expect(hasRollbackDefined([{ ...base, description: 'On failure, the pipeline rolls back all completed steps.' }])).toBe(true)
  })
  it('returns true when compensation is mentioned', () => {
    expect(hasRollbackDefined([{ ...base, description: 'A compensation transaction undoes partial writes.' }])).toBe(true)
  })
})
