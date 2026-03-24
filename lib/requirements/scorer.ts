import type { DetectedGap } from '@/lib/requirements/gap-detector'
import type { ParsedItem } from '@/lib/requirements/parser'
import type { ScoreBreakdown } from '@/lib/supabase/types'

export interface ComputedScore {
  completeness: number
  nfr_score: number
  overall_score: number
  confidence: number
  breakdown: ScoreBreakdown
}

const NFR_WEIGHTS: Record<'security' | 'performance' | 'auditability', number> = {
  security: 34,
  performance: 33,
  auditability: 33,
}

export function computeScore(
  gaps: DetectedGap[],
  mergedIndices: Set<number>,
  items: ParsedItem[]
): ComputedScore {
  const activeGaps = gaps.filter((_, i) => !mergedIndices.has(i))

  const criticalCount = activeGaps.filter(g => g.severity === 'critical').length
  const majorCount = activeGaps.filter(g => g.severity === 'major').length
  const minorCount = activeGaps.filter(g => g.severity === 'minor').length

  const completeness = Math.max(0, 100 - criticalCount * 20 - majorCount * 10 - minorCount * 3)

  const nfrCoverage = {
    security: items.some(i => i.type === 'non-functional' && i.nfr_category === 'security'),
    performance: items.some(i => i.type === 'non-functional' && i.nfr_category === 'performance'),
    auditability: items.some(
      i => i.type === 'non-functional' && i.nfr_category === 'auditability'
    ),
  }

  const nfr_score =
    (nfrCoverage.security ? NFR_WEIGHTS.security : 0) +
    (nfrCoverage.performance ? NFR_WEIGHTS.performance : 0) +
    (nfrCoverage.auditability ? NFR_WEIGHTS.auditability : 0)

  const overall_score = Math.round(completeness * 0.7 + nfr_score * 0.3)

  const aiGaps = activeGaps.filter(g => g.source === 'ai')
  const confidence =
    aiGaps.length === 0
      ? 100
      : Math.round(aiGaps.reduce((sum, g) => sum + g.confidence, 0) / aiGaps.length)

  const breakdown: ScoreBreakdown = {
    completeness,
    nfr_score,
    overall: overall_score,
    confidence,
    gap_counts: { critical: criticalCount, major: majorCount, minor: minorCount },
    nfr_coverage: nfrCoverage,
  }

  return { completeness, nfr_score, overall_score, confidence, breakdown }
}
