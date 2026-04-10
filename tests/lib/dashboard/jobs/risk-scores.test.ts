import { describe, it, expect } from 'vitest'
import {
  computeEffectiveMissRate,
  computeRiskScore,
  assignTier,
  applyHardCap,
} from '@/lib/dashboard/jobs/risk-scores'

describe('computeEffectiveMissRate', () => {
  it('damps miss_rate for small samples', () => {
    // n=2, k=7: effective = 0.5 * (1 - e^(-2/7)) ≈ 0.5 * 0.248 ≈ 0.124
    const eff = computeEffectiveMissRate(0.5, 2)
    expect(eff).toBeCloseTo(0.124, 2)
  })

  it('approaches raw miss_rate for large samples', () => {
    // n=30, k=7: effective ≈ 0.8 * (1 - e^(-30/7)) ≈ 0.8 * 0.986 ≈ 0.789
    const eff = computeEffectiveMissRate(0.8, 30)
    expect(eff).toBeGreaterThan(0.77)
    expect(eff).toBeLessThan(0.8)
  })

  it('returns 0 for 0 miss_rate', () => {
    expect(computeEffectiveMissRate(0, 10)).toBe(0)
  })
})

describe('computeRiskScore', () => {
  it('produces a score between 0 and 1', () => {
    const score = computeRiskScore({
      effectiveMissRate: 0.5,
      missFrequency: 0.3,
      dependencyCentrality: 0.8,
      changeFrequency: 0.4,
      modelConfidence: 0.6,
      recencyWeight: 1.0,
    })
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(1)
  })

  it('weights miss_rate most heavily (0.60)', () => {
    const highMiss = computeRiskScore({
      effectiveMissRate: 1.0, missFrequency: 0, dependencyCentrality: 0, changeFrequency: 0, modelConfidence: 0, recencyWeight: 1,
    })
    const highCentrality = computeRiskScore({
      effectiveMissRate: 0, missFrequency: 0, dependencyCentrality: 1.0, changeFrequency: 0, modelConfidence: 0, recencyWeight: 1,
    })
    expect(highMiss).toBeGreaterThan(highCentrality)
  })
})

describe('applyHardCap', () => {
  it('downgrades lowest HIGH to MEDIUM when more than 2 are HIGH', () => {
    const scores = [
      { componentId: 'a', riskScore: 0.9, tier: 'HIGH' as const },
      { componentId: 'b', riskScore: 0.85, tier: 'HIGH' as const },
      { componentId: 'c', riskScore: 0.75, tier: 'HIGH' as const },
    ]
    const capped = applyHardCap(scores)
    const highs = capped.filter(s => s.tier === 'HIGH')
    expect(highs).toHaveLength(2)
    expect(capped.find(s => s.componentId === 'c')?.tier).toBe('MEDIUM')
  })

  it('keeps 2 HIGH items unchanged', () => {
    const scores = [
      { componentId: 'a', riskScore: 0.9, tier: 'HIGH' as const },
      { componentId: 'b', riskScore: 0.85, tier: 'HIGH' as const },
    ]
    const capped = applyHardCap(scores)
    expect(capped.filter(s => s.tier === 'HIGH')).toHaveLength(2)
  })
})
