import { describe, it, expect } from 'vitest'
import { computeOverallStatus, computeWeightedMissRate, formatTrendArrow } from '@/lib/dashboard/jobs/system-signals'

describe('computeOverallStatus', () => {
  it('returns Improving when all deltas are positive', () => {
    expect(computeOverallStatus({ accuracyDelta: 5, missRateDelta: -3, successRateDelta: 8 })).toBe('Improving')
  })

  it('returns Degrading when all deltas are negative', () => {
    expect(computeOverallStatus({ accuracyDelta: -10, missRateDelta: 5, successRateDelta: -5 })).toBe('Degrading')
  })

  it('returns Mixed when signals disagree', () => {
    expect(computeOverallStatus({ accuracyDelta: 5, missRateDelta: 3, successRateDelta: -2 })).toBe('Mixed')
  })
})

describe('computeWeightedMissRate', () => {
  it('weights higher-centrality components more', () => {
    const missed = [
      { component_id: 'a', centrality: 8 },
      { component_id: 'b', centrality: 2 },
    ]
    const actual = [
      { component_id: 'a', centrality: 8 },
      { component_id: 'b', centrality: 2 },
      { component_id: 'c', centrality: 1 },
    ]
    const rate = computeWeightedMissRate(missed, actual)
    // missed weight = 8+2=10, actual weight = 8+2+1=11, rate = 10/11 ≈ 0.909
    expect(rate).toBeCloseTo(0.909, 2)
  })

  it('returns 0 when nothing was missed', () => {
    expect(computeWeightedMissRate([], [{ component_id: 'a', centrality: 5 }])).toBe(0)
  })

  it('returns 0 when actual list is empty', () => {
    expect(computeWeightedMissRate([], [])).toBe(0)
  })
})

describe('formatTrendArrow', () => {
  it('shows arrow only when abs(delta) >= 5', () => {
    expect(formatTrendArrow(6)).toBe('↑')
    expect(formatTrendArrow(-6)).toBe('↓')
    expect(formatTrendArrow(4)).toBe('~ stable')
    expect(formatTrendArrow(-4)).toBe('~ stable')
  })

  it('shows arrow at exactly 5 and -5', () => {
    expect(formatTrendArrow(5)).toBe('↑')
    expect(formatTrendArrow(-5)).toBe('↓')
  })
})
