import type { Gap, RequirementStatus } from '@/lib/supabase/types'

export function resolveGap(
  gap: Gap,
  source: 'question_answered' | 'task_resolved' | 'decision_recorded'
): Gap {
  return {
    ...gap,
    resolved_at: new Date().toISOString(),
    resolution_source: source,
  }
}

/**
 * Compute requirement status from current gap state.
 * - incomplete: any unresolved critical gap (merged gaps excluded)
 * - review_required: no critical, but unresolved major gaps
 * - ready_for_dev: no unresolved critical or major gaps (minor alone does not block)
 */
export function computeStatusFromScore(allGaps: Gap[]): RequirementStatus {
  const unresolved = allGaps.filter(g => g.resolved_at === null && g.merged_into === null)
  if (unresolved.some(g => g.severity === 'critical')) return 'incomplete'
  if (unresolved.some(g => g.severity === 'major')) return 'review_required'
  return 'ready_for_dev'
}
