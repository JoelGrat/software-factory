import { describe, it, expect } from 'vitest'
import { hasErrorHandling } from '@/lib/requirements/rules/has-error-handling'
import type { ParsedItem } from '@/lib/requirements/parser'

const base: ParsedItem = {
  type: 'functional', title: 'x', description: 'x', priority: 'low', source_text: 'x', nfr_category: null,
}

describe('hasErrorHandling', () => {
  it('returns false when no error handling mentioned', () => {
    expect(hasErrorHandling([{ ...base, description: 'User logs in successfully.' }])).toBe(false)
  })
  it('returns true when failure scenario is described', () => {
    expect(hasErrorHandling([{ ...base, description: 'If login fails, show error message.' }])).toBe(true)
  })
  it('returns true for exception keyword', () => {
    expect(hasErrorHandling([{ ...base, title: 'Handle timeout exceptions' }])).toBe(true)
  })
})
