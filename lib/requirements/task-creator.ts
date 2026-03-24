import type { DetectedGap } from '@/lib/requirements/gap-detector'

export interface TaskToCreate {
  gap_index: number
  title: string
  description: string
  priority: 'high' | 'medium' | 'low'
}

export function createTasks(gaps: DetectedGap[], mergedIndices: Set<number>): TaskToCreate[] {
  return gaps
    .map((gap, idx) => ({ gap, idx }))
    .filter(({ gap, idx }) => !mergedIndices.has(idx) && (gap.severity === 'critical' || gap.severity === 'major'))
    .map(({ gap, idx }) => ({
      gap_index: idx,
      title: `Investigate: ${gap.description.slice(0, 80)}`,
      description: `Gap detected by ${gap.source === 'rule' ? `rule ${gap.rule_id}` : 'AI analysis'}: ${gap.description}`,
      priority: gap.severity === 'critical' ? ('high' as const) : ('medium' as const),
    }))
}
