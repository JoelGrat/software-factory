import { describe, it, expect } from 'vitest'
import { computeRiskScore } from '@/lib/impact/risk-scorer'
import type { RiskFactors, ComponentWeight } from '@/lib/impact/types'

function baseFactors(overrides: Partial<RiskFactors> = {}): RiskFactors {
  return {
    blastRadius: 0,
    unknownDepsCount: 0,
    hasLowConfidenceComponents: false,
    componentTypes: [],
    dynamicImportCount: 0,
    ...overrides,
  }
}

function makeWeights(count: number, weight = 0.5): ComponentWeight[] {
  return Array.from({ length: count }, (_, i) => ({
    componentId: `c${i}`,
    weight,
    source: 'via_file' as const,
    sourceDetail: `f${i}`,
  }))
}

describe('computeRiskScore', () => {
  it('returns low risk for empty analysis', () => {
    const result = computeRiskScore(baseFactors(), [])
    expect(result.riskLevel).toBe('low')
    expect(result.score).toBeLessThan(10)
  })

  it('blast radius above 0.3 threshold adds score', () => {
    const weights = makeWeights(5, 0.5) // all above 0.3
    const result = computeRiskScore(baseFactors({ blastRadius: 5 }), weights)
    expect(result.score).toBeGreaterThan(0)
    expect(result.confidenceBreakdown.blast_radius).toBeGreaterThan(0)
  })

  it('unknown deps increase score', () => {
    const r1 = computeRiskScore(baseFactors({ unknownDepsCount: 0 }), [])
    const r2 = computeRiskScore(baseFactors({ unknownDepsCount: 3 }), [])
    expect(r2.score).toBeGreaterThan(r1.score)
    expect(r2.confidenceBreakdown.unknown_deps).toBeGreaterThan(0)
  })

  it('low confidence components add score', () => {
    const r1 = computeRiskScore(baseFactors({ hasLowConfidenceComponents: false }), [])
    const r2 = computeRiskScore(baseFactors({ hasLowConfidenceComponents: true }), [])
    expect(r2.score).toBeGreaterThan(r1.score)
    expect(r2.confidenceBreakdown.low_confidence).toBeGreaterThan(0)
  })

  it('auth component type amplifies score', () => {
    const r1 = computeRiskScore(baseFactors({ componentTypes: ['service'] }), [])
    const r2 = computeRiskScore(baseFactors({ componentTypes: ['auth'] }), [])
    expect(r2.score).toBeGreaterThan(r1.score)
    expect(r2.confidenceBreakdown.auth_component).toBeGreaterThan(0)
  })

  it('database component type adds score', () => {
    const r1 = computeRiskScore(baseFactors(), [])
    const r2 = computeRiskScore(baseFactors({ componentTypes: ['database'] }), [])
    expect(r2.score).toBeGreaterThan(r1.score)
    expect(r2.confidenceBreakdown.data_component).toBeGreaterThan(0)
  })

  it('dynamic imports add score', () => {
    const r1 = computeRiskScore(baseFactors({ dynamicImportCount: 0 }), [])
    const r2 = computeRiskScore(baseFactors({ dynamicImportCount: 4 }), [])
    expect(r2.score).toBeGreaterThan(r1.score)
  })

  it('score >= 25 is high risk', () => {
    const weights = makeWeights(10, 0.5) // 10 components above 0.3
    const factors = baseFactors({
      blastRadius: 10,
      unknownDepsCount: 5,
      hasLowConfidenceComponents: true,
      componentTypes: ['auth', 'database'],
      dynamicImportCount: 5,
    })
    const result = computeRiskScore(factors, weights)
    expect(result.riskLevel).toBe('high')
    expect(result.score).toBeGreaterThanOrEqual(25)
  })

  it('10 <= score < 25 is medium risk', () => {
    const weights = makeWeights(4, 0.5)
    const factors = baseFactors({ blastRadius: 4 })
    const result = computeRiskScore(factors, weights)
    expect(result.score).toBeGreaterThanOrEqual(10)
    expect(result.score).toBeLessThan(25)
    expect(result.riskLevel).toBe('medium')
  })

  it('primaryRiskFactor is the highest-weighted breakdown entry', () => {
    const weights = makeWeights(5, 0.5)
    const factors = baseFactors({ blastRadius: 5, unknownDepsCount: 1 })
    const result = computeRiskScore(factors, weights)
    expect(result.primaryRiskFactor).toBe('blast_radius')
  })
})
