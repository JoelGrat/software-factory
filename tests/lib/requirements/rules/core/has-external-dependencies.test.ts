import { describe, it, expect } from 'vitest'
import { hasExternalDependenciesDefined } from '@/lib/requirements/rules/core/has-external-dependencies'
import type { ParsedItem } from '@/lib/requirements/parser'

const base: ParsedItem = {
  type: 'functional', title: 'x', description: 'x', priority: 'low', source_text: null, nfr_category: null,
}

describe('hasExternalDependenciesDefined', () => {
  it('returns true when no external systems are mentioned', () => {
    // no external = no gap
    expect(hasExternalDependenciesDefined([{ ...base, description: 'The system stores orders.' }])).toBe(true)
  })
  it('returns false when external system mentioned without a contract', () => {
    expect(hasExternalDependenciesDefined([
      { ...base, description: 'The system integrates with Stripe for payments.' },
    ])).toBe(false)
  })
  it('returns true when external system mentioned AND a contract item exists', () => {
    expect(hasExternalDependenciesDefined([
      { ...base, description: 'The system integrates with Stripe for payments.' },
      { ...base, description: 'The Stripe API contract requires a webhook endpoint at /webhooks/stripe.' },
    ])).toBe(true)
  })
  it('returns true when vendor mentioned and specification item present', () => {
    expect(hasExternalDependenciesDefined([
      { ...base, description: 'The vendor sends data via webhook.' },
      { ...base, description: 'The webhook protocol uses HMAC-SHA256 signatures.' },
    ])).toBe(true)
  })
})
