import { describe, it, expect } from 'vitest'
import { validateStatusTransition, checkReadyForDevGate } from '@/lib/requirements/status-validator'

describe('validateStatusTransition', () => {
  it('allows draft → analyzing', () => {
    expect(validateStatusTransition('draft', 'analyzing')).toBe(true)
  })
  it('blocks draft → ready_for_dev', () => {
    expect(validateStatusTransition('draft', 'ready_for_dev')).toBe(false)
  })
  it('allows incomplete → review_required', () => {
    expect(validateStatusTransition('incomplete', 'review_required')).toBe(true)
  })
  it('allows incomplete → ready_for_dev', () => {
    expect(validateStatusTransition('incomplete', 'ready_for_dev')).toBe(true)
  })
  it('blocks draft → blocked', () => {
    expect(validateStatusTransition('draft', 'blocked')).toBe(false)
  })
  it('allows blocked → incomplete', () => {
    expect(validateStatusTransition('blocked', 'incomplete')).toBe(true)
  })
})

describe('checkReadyForDevGate', () => {
  it('blocks if critical gaps unresolved', () => {
    const gaps = [{ severity: 'critical', resolved_at: null, merged_into: null }]
    expect(checkReadyForDevGate(gaps)).toEqual({ blocked: true, reason: expect.stringContaining('critical') })
  })
  it('blocks if major gaps unresolved', () => {
    const gaps = [{ severity: 'major', resolved_at: null, merged_into: null }]
    expect(checkReadyForDevGate(gaps)).toEqual({ blocked: true, reason: expect.stringContaining('major') })
  })
  it('allows if only minor gaps unresolved', () => {
    const gaps = [{ severity: 'minor', resolved_at: null, merged_into: null }]
    expect(checkReadyForDevGate(gaps)).toEqual({ blocked: false })
  })
  it('allows if all gaps resolved', () => {
    const gaps = [{ severity: 'critical', resolved_at: '2026-01-01', merged_into: null }]
    expect(checkReadyForDevGate(gaps)).toEqual({ blocked: false })
  })
  it('ignores merged gaps', () => {
    const gaps = [{ severity: 'critical', resolved_at: null, merged_into: 'other-id' }]
    expect(checkReadyForDevGate(gaps)).toEqual({ blocked: false })
  })
})
