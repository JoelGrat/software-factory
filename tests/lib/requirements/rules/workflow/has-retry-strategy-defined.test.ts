import { describe, it, expect } from 'vitest'
import { hasRetryStrategyDefined } from '@/lib/requirements/rules/workflow/has-retry-strategy-defined'
import type { ParsedItem } from '@/lib/requirements/parser'

const base: ParsedItem = { type: 'functional', title: 'x', description: 'x', priority: 'low', source_text: null, nfr_category: null }

describe('hasRetryStrategyDefined', () => {
  it('returns false when no retry keywords present', () => {
    expect(hasRetryStrategyDefined([{ ...base, description: 'The job processes tasks sequentially.' }])).toBe(false)
  })
  it('returns true when retry behaviour is described', () => {
    expect(hasRetryStrategyDefined([{ ...base, description: 'Failed tasks are retried up to 3 times with exponential backoff.' }])).toBe(true)
  })
  it('returns true when backoff is in the title', () => {
    expect(hasRetryStrategyDefined([{ ...base, title: 'Exponential backoff for failed webhook deliveries' }])).toBe(true)
  })
})
