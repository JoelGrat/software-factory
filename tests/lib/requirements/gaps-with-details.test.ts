import { describe, it, expect } from 'vitest'
import { buildGapsWithDetails } from '@/lib/requirements/gaps-with-details'
import type { Gap, Question, InvestigationTask } from '@/lib/supabase/types'

const baseGap = (overrides: Partial<Gap> = {}): Gap => ({
  id: 'g1', requirement_id: 'r1', item_id: null,
  severity: 'critical', category: 'missing', description: 'desc',
  source: 'rule', rule_id: null, priority_score: 9,
  confidence: 100, validated: false, validated_by: null,
  question_generated: false, merged_into: null,
  resolved_at: null, resolution_source: null, created_at: '2026-01-01',
  ...overrides,
})

const baseQuestion = (overrides: Partial<Question> = {}): Question => ({
  id: 'q1', gap_id: 'g1', requirement_id: 'r1',
  question_text: 'Who approves?', target_role: 'ba',
  status: 'open', answer: null, answered_at: null, created_at: '2026-01-01',
  ...overrides,
})

const baseTask = (overrides: Partial<InvestigationTask> = {}): InvestigationTask => ({
  id: 't1', requirement_id: 'r1', linked_gap_id: 'g1',
  title: 'Investigate', description: 'desc',
  priority: 'high', status: 'open', created_at: '2026-01-01',
  ...overrides,
})

describe('buildGapsWithDetails', () => {
  it('attaches question and task to their gap', () => {
    const result = buildGapsWithDetails([baseGap()], [baseQuestion()], [baseTask()])
    expect(result[0].question?.id).toBe('q1')
    expect(result[0].task?.id).toBe('t1')
  })

  it('gap with no question or task gets null for both', () => {
    const result = buildGapsWithDetails([baseGap()], [], [])
    expect(result[0].question).toBeNull()
    expect(result[0].task).toBeNull()
  })

  it('counts how many gaps are merged into each survivor', () => {
    const survivor = baseGap({ id: 'g1' })
    const merged = baseGap({ id: 'g2', merged_into: 'g1' })
    const result = buildGapsWithDetails([survivor, merged], [], [])
    expect(result.find(g => g.id === 'g1')?.merged_count).toBe(1)
    expect(result.find(g => g.id === 'g2')?.merged_count).toBe(0)
  })

  it('sorts by priority_score descending', () => {
    const low = baseGap({ id: 'g1', priority_score: 2 })
    const high = baseGap({ id: 'g2', priority_score: 9 })
    const result = buildGapsWithDetails([low, high], [], [])
    expect(result[0].id).toBe('g2')
    expect(result[1].id).toBe('g1')
  })
})
