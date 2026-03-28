import type { RequirementStatus } from '@/lib/supabase/types'

const VALID_TRANSITIONS: Record<RequirementStatus, RequirementStatus[]> = {
  draft: ['analyzing', 'ready_for_dev'],
  analyzing: ['incomplete', 'review_required', 'ready_for_dev'],
  incomplete: ['review_required', 'ready_for_dev', 'blocked'],
  review_required: ['ready_for_dev', 'blocked'],
  ready_for_dev: ['blocked'],
  blocked: ['draft', 'analyzing', 'incomplete', 'review_required', 'ready_for_dev'],
}

export function validateStatusTransition(from: RequirementStatus, to: RequirementStatus): boolean {
  return (VALID_TRANSITIONS[from] ?? []).includes(to)
}

interface GapGateRow {
  severity: string
  resolved_at: string | null
  merged_into: string | null
}

export function checkReadyForDevGate(gaps: GapGateRow[]): { blocked: boolean; reason?: string } {
  const active = gaps.filter(g => g.resolved_at === null && g.merged_into === null)
  const critCount = active.filter(g => g.severity === 'critical').length
  const majorCount = active.filter(g => g.severity === 'major').length
  if (critCount > 0) return { blocked: true, reason: `${critCount} unresolved critical gap(s)` }
  if (majorCount > 0) return { blocked: true, reason: `${majorCount} unresolved major gap(s)` }
  return { blocked: false }
}
