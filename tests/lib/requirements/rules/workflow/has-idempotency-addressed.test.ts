import { describe, it, expect } from 'vitest'
import { hasIdempotencyAddressed } from '@/lib/requirements/rules/workflow/has-idempotency-addressed'
import type { ParsedItem } from '@/lib/requirements/parser'

const base: ParsedItem = { type: 'functional', title: 'x', description: 'x', priority: 'low', source_text: null, nfr_category: null }

describe('hasIdempotencyAddressed', () => {
  it('returns false when no idempotency keywords present', () => {
    expect(hasIdempotencyAddressed([{ ...base, description: 'The pipeline reads events.' }])).toBe(false)
  })
  it('returns true when idempotency is mentioned', () => {
    expect(hasIdempotencyAddressed([{ ...base, description: 'All operations are idempotent using an idempotency key.' }])).toBe(true)
  })
  it('returns true when duplicate handling is mentioned', () => {
    expect(hasIdempotencyAddressed([{ ...base, description: 'Duplicate events are detected and discarded.' }])).toBe(true)
  })
})
