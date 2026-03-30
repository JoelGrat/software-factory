// TODO: replaced in Plan 2/3/4 — old types removed in migration 006
/* eslint-disable @typescript-eslint/no-explicit-any */
// import type { Gap, Question, InvestigationTask, GapSeverity, GapCategory, GapSource, TargetRole, QuestionStatus, TaskStatus } from '@/lib/supabase/types' // removed in migration 006

export interface GapWithDetails {
  id: string
  item_id: string | null
  severity: any
  category: any
  description: string
  source: any
  rule_id: string | null
  priority_score: number
  confidence: number
  question_generated: boolean
  merged_into: string | null
  resolved_at: string | null
  resolution_source: string | null
  question: {
    id: string
    question_text: string
    target_role: any
    status: any
    answer: string | null
  } | null
  task: {
    id: string
    title: string
    status: any
    priority: 'high' | 'medium' | 'low'
  } | null
  merged_count: number
}

export function buildGapsWithDetails(
  gaps: any[],
  questions: any[],
  tasks: any[]
): GapWithDetails[] {
  const questionByGapId = new Map(questions.map(q => [q.gap_id, q]))
  const taskByGapId = new Map(
    tasks.filter(t => t.linked_gap_id !== null).map(t => [t.linked_gap_id!, t])
  )
  const mergedCountById = new Map<string, number>()

  for (const gap of gaps) {
    if (gap.merged_into) {
      mergedCountById.set(gap.merged_into, (mergedCountById.get(gap.merged_into) ?? 0) + 1)
    }
  }

  return [...gaps]
    .sort((a, b) => b.priority_score - a.priority_score)
    .map(gap => {
      const q = questionByGapId.get(gap.id)
      const t = taskByGapId.get(gap.id)
      return {
        id: gap.id,
        item_id: gap.item_id,
        severity: gap.severity,
        category: gap.category,
        description: gap.description,
        source: gap.source,
        rule_id: gap.rule_id,
        priority_score: gap.priority_score,
        confidence: gap.confidence,
        question_generated: gap.question_generated,
        merged_into: gap.merged_into,
        resolved_at: gap.resolved_at,
        resolution_source: gap.resolution_source,
        question: q ? { id: q.id, question_text: q.question_text, target_role: q.target_role, status: q.status, answer: q.answer } : null,
        task: t ? { id: t.id, title: t.title, status: t.status, priority: t.priority } : null,
        merged_count: mergedCountById.get(gap.id) ?? 0,
      }
    })
}
