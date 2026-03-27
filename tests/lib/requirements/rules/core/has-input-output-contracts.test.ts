import { describe, it, expect } from 'vitest'
import { hasInputOutputContracts } from '@/lib/requirements/rules/core/has-input-output-contracts'
import type { ParsedItem } from '@/lib/requirements/parser'

const base: ParsedItem = {
  type: 'functional', title: 'x', description: 'x', priority: 'low', source_text: null, nfr_category: null,
}

describe('hasInputOutputContracts', () => {
  it('returns false when no contract keywords present', () => {
    expect(hasInputOutputContracts([{ ...base, description: 'The system validates the user.' }])).toBe(false)
  })
  it('returns true when description mentions API', () => {
    expect(hasInputOutputContracts([{ ...base, description: 'The REST API accepts a JSON payload.' }])).toBe(true)
  })
  it('returns true when description mentions request/response', () => {
    expect(hasInputOutputContracts([{ ...base, description: 'The response returns a 200 status.' }])).toBe(true)
  })
  it('returns true when title mentions endpoint', () => {
    expect(hasInputOutputContracts([{ ...base, title: 'POST /orders endpoint' }])).toBe(true)
  })
})
