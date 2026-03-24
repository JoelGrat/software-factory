import { describe, it, expect } from 'vitest'
import { hasActorsDefined } from '@/lib/requirements/rules/has-actors-defined'
import type { ParsedItem } from '@/lib/requirements/parser'

const base: ParsedItem = {
  type: 'functional', title: 'x', description: 'x', priority: 'low', source_text: 'x', nfr_category: null,
}

describe('hasActorsDefined', () => {
  it('returns false when no actor is named', () => {
    expect(hasActorsDefined([{ ...base, description: 'The system processes the request.' }])).toBe(false)
  })
  it('returns true when a user role is mentioned', () => {
    expect(hasActorsDefined([{ ...base, description: 'Admin can manage all accounts.' }])).toBe(true)
  })
  it('returns true when a named system actor is referenced', () => {
    expect(hasActorsDefined([{ ...base, description: 'The payment gateway validates the card.' }])).toBe(true)
  })
})
