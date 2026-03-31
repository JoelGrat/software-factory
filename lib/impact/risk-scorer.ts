import type { RiskFactors, ComponentWeight, RiskScoreResult } from './types'

export function computeRiskScore(
  factors: RiskFactors,
  componentWeights: ComponentWeight[]
): RiskScoreResult {
  let score = 0
  const breakdown: Record<string, number> = {}

  // Blast radius: components with weight > 0.3 (capped at 15)
  const significantCount = componentWeights.filter(c => c.weight > 0.3).length
  if (significantCount > 0) {
    const s = Math.min(significantCount * 3, 15)
    score += s
    breakdown.blast_radius = s
  }

  // Unknown deps (capped at 8)
  if (factors.unknownDepsCount > 0) {
    const s = Math.min(factors.unknownDepsCount * 2, 8)
    score += s
    breakdown.unknown_deps = s
  }

  // Low confidence penalty
  if (factors.hasLowConfidenceComponents) {
    score += 4
    breakdown.low_confidence = 4
  }

  // Auth component amplifier
  if (factors.componentTypes.includes('auth')) {
    score += 5
    breakdown.auth_component = 5
  }

  // Data component amplifier
  if (factors.componentTypes.some(t => t === 'database' || t === 'repository')) {
    score += 3
    breakdown.data_component = 3
  }

  // Dynamic imports (capped at 5)
  if (factors.dynamicImportCount > 0) {
    const s = Math.min(factors.dynamicImportCount, 5)
    score += s
    breakdown.dynamic_imports = s
  }

  const riskLevel: RiskScoreResult['riskLevel'] = score < 10 ? 'low' : score < 25 ? 'medium' : 'high'
  const primaryRiskFactor =
    Object.entries(breakdown).sort(([, a], [, b]) => b - a)[0]?.[0] ?? 'none'

  return { score, riskLevel, primaryRiskFactor, confidenceBreakdown: breakdown }
}
