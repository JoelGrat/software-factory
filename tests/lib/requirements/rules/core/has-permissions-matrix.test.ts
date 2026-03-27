import { describe, it, expect } from 'vitest'
import { hasPermissionsMatrix } from '@/lib/requirements/rules/core/has-permissions-matrix'
import type { ParsedItem } from '@/lib/requirements/parser'

const base: ParsedItem = {
  type: 'functional', title: 'x', description: 'x', priority: 'low', source_text: null, nfr_category: null,
}

describe('hasPermissionsMatrix', () => {
  it('returns false when no permission keywords present', () => {
    expect(hasPermissionsMatrix([{ ...base, description: 'The user submits the form.' }])).toBe(false)
  })
  it('returns true when description mentions permission', () => {
    expect(hasPermissionsMatrix([{ ...base, description: 'Permissions are role-based.' }])).toBe(true)
  })
  it('returns true when description mentions access control', () => {
    expect(hasPermissionsMatrix([{ ...base, description: 'Access control restricts admin features.' }])).toBe(true)
  })
  it('returns true when title mentions authorization', () => {
    expect(hasPermissionsMatrix([{ ...base, title: 'Authorization rules for editors' }])).toBe(true)
  })
})
