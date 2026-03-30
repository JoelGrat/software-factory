import type { DetectedGap } from '@/lib/requirements/gap-detector'
import type { ParsedItem } from '@/lib/requirements/parser'
// TODO: replaced in Plan 2/3/4 — old types removed in migration 006
/* eslint-disable @typescript-eslint/no-explicit-any */
// import type { ScoreBreakdown } from '@/lib/supabase/types' // removed in migration 006

export interface ComputedScore {
  blocking_count: number
  high_risk_count: number
  coverage_pct: number
  internal_score: number
  nfr_score: number
  breakdown: any
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
  const unvalidatedCount = activeGaps.filter(g => !g.validated).length

  const coverage_pct = Math.max(0, 100 - criticalCount * 20 - majorCount * 10 - minorCount * 3)

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

  const internal_score = Math.round(coverage_pct * 0.7 + nfr_score * 0.3)

  const breakdown: any = {
    blocking_count: criticalCount,
    high_risk_count: majorCount,
    coverage_pct,
    internal_score,
    nfr_score,
    gap_density: activeGaps.length > 0 ? activeGaps.length / Math.max(items.length, 1) : 0,
    complexity_score: 0,
    risk_flags: [],
    gap_counts: { critical: criticalCount, major: majorCount, minor: minorCount, unvalidated: unvalidatedCount },
    nfr_coverage: nfrCoverage,
  }

  return { blocking_count: criticalCount, high_risk_count: majorCount, coverage_pct, internal_score, nfr_score, breakdown }
}
