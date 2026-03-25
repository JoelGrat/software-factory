import { describe, it, expect } from 'vitest'
import { validateDecision } from '@/lib/requirements/validate-decision'

describe('validateDecision', () => {
  it('returns null for valid input', () => {
    expect(validateDecision({ gap_id: 'g1', decision: 'We will use OAuth', rationale: 'Industry standard' })).toBeNull()
  })
  it('requires gap_id', () => {
    expect(validateDecision({ decision: 'x', rationale: 'y' })).toBe('gap_id is required')
  })
  it('requires decision', () => {
    expect(validateDecision({ gap_id: 'g1', rationale: 'y' })).toBe('decision is required')
  })
  it('requires rationale', () => {
    expect(validateDecision({ gap_id: 'g1', decision: 'x' })).toBe('rationale is required')
  })
  it('rejects whitespace-only decision', () => {
    expect(validateDecision({ gap_id: 'g1', decision: '   ', rationale: 'y' })).toBe('decision is required')
  })
  it('rejects whitespace-only rationale', () => {
    expect(validateDecision({ gap_id: 'g1', decision: 'x', rationale: '   ' })).toBe('rationale is required')
  })
})
