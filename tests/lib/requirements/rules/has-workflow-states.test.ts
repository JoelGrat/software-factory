import { describe, it, expect } from 'vitest'
import { hasWorkflowStates } from '@/lib/requirements/rules/has-workflow-states'
import type { ParsedItem } from '@/lib/requirements/parser'

const base: ParsedItem = {
  type: 'functional', title: 'x', description: 'x', priority: 'low', source_text: 'x', nfr_category: null,
}

describe('hasWorkflowStates', () => {
  it('returns false when no state/status language exists', () => {
    expect(hasWorkflowStates([{ ...base, description: 'User submits a form.' }])).toBe(false)
  })
  it('returns true when an item defines a state transition', () => {
    expect(hasWorkflowStates([{ ...base, description: 'Order transitions from pending to confirmed.' }])).toBe(true)
  })
  it('returns true for status keyword', () => {
    expect(hasWorkflowStates([{ ...base, title: 'Order status management' }])).toBe(true)
  })
})
