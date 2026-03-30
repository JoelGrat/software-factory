// TODO: replaced in Plan 2/3/4 — old types removed in migration 006
/* eslint-disable @typescript-eslint/no-explicit-any */
// import type { Gap, RequirementStatus } from '@/lib/supabase/types' // removed in migration 006

export function resolveGap(
  gap: any,
  source: 'question_answered' | 'task_resolved' | 'decision_recorded'
): any {
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
export function computeStatusFromScore(allGaps: any[]): any {
  const unresolved = allGaps.filter(g => g.resolved_at === null && g.merged_into === null)
  if (unresolved.some(g => g.severity === 'critical')) return 'incomplete'
  if (unresolved.some(g => g.severity === 'major')) return 'review_required'
  return 'ready_for_dev'
}
