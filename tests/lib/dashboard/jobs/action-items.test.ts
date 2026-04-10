import { describe, it, expect } from 'vitest'
import { computePriorityScore, applyDominanceRule } from '@/lib/dashboard/jobs/action-items'

describe('computePriorityScore', () => {
  it('weights impact most heavily (0.5)', () => {
    const highImpact = computePriorityScore({ impactComponents: 1.0, failureFrequency: 0, recencyHours: 0 })
    const highFreq = computePriorityScore({ impactComponents: 0, failureFrequency: 1.0, recencyHours: 0 })
    expect(highImpact).toBeGreaterThan(highFreq)
  })

  it('decays older items via recency', () => {
    const recent = computePriorityScore({ impactComponents: 0.5, failureFrequency: 0.5, recencyHours: 1 })
    const old = computePriorityScore({ impactComponents: 0.5, failureFrequency: 0.5, recencyHours: 72 })
    expect(recent).toBeGreaterThan(old)
  })
})

describe('applyDominanceRule', () => {
  it('suppresses tier 2 items when tier 1 exists', () => {
    const items = [
      { tier: 1, source: 'pattern', componentId: 'a', priorityScore: 0.9, payload: {} },
      { tier: 2, source: 'model_quality', componentId: 'b', priorityScore: 0.7, payload: {} },
    ]
    const filtered = applyDominanceRule(items)
    expect(filtered.filter(i => i.tier === 2)).toHaveLength(0)
  })

  it('includes tier 2 item if it shares a component with a tier 1 item (merge candidate)', () => {
    const items = [
      { tier: 1, source: 'pattern', componentId: 'a', priorityScore: 0.9, payload: {} },
      { tier: 2, source: 'model_quality', componentId: 'a', priorityScore: 0.7, payload: {} },
    ]
    const filtered = applyDominanceRule(items)
    expect(filtered).toHaveLength(2)
  })

  it('shows tier 3 only when no tier 1 or 2 items exist', () => {
    const items = [
      { tier: 3, source: 'opportunity', componentId: 'c', priorityScore: 0.3, payload: {} },
    ]
    const filtered = applyDominanceRule(items)
    expect(filtered).toHaveLength(1)
  })

  it('suppresses tier 3 when tier 1 exists', () => {
    const items = [
      { tier: 1, source: 'pattern', componentId: 'a', priorityScore: 0.9, payload: {} },
      { tier: 3, source: 'opportunity', componentId: 'c', priorityScore: 0.3, payload: {} },
    ]
    const filtered = applyDominanceRule(items)
    expect(filtered.filter(i => i.tier === 3)).toHaveLength(0)
  })
})
