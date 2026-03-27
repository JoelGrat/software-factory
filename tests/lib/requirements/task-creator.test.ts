import { describe, it, expect } from 'vitest'
import { createTasks } from '@/lib/requirements/task-creator'
import type { DetectedGap } from '@/lib/requirements/gap-detector'

const makeGap = (severity: 'critical' | 'major' | 'minor', idx: number): DetectedGap => ({
  item_id: null,
  severity,
  category: 'missing',
  description: `Gap ${idx} — needs investigation`,
  source: 'rule',
  rule_id: 'x',
  priority_score: 9,
  confidence: 100,
  question_generated: false,
  validated: true,
})

describe('createTasks', () => {
  it('creates tasks for critical and major gaps only', () => {
    const gaps = [makeGap('critical', 0), makeGap('major', 1), makeGap('minor', 2)]
    const result = createTasks(gaps, new Set())
    expect(result).toHaveLength(2)
  })

  it('skips merged gaps', () => {
    const gaps = [makeGap('critical', 0), makeGap('critical', 1)]
    const mergedIndices = new Set([1])
    const result = createTasks(gaps, mergedIndices)
    expect(result).toHaveLength(1)
  })

  it('sets priority high for critical, medium for major', () => {
    const gaps = [makeGap('critical', 0), makeGap('major', 1)]
    const result = createTasks(gaps, new Set())
    expect(result[0].priority).toBe('high')
    expect(result[1].priority).toBe('medium')
  })

  it('includes gap_index to link back to inserted gap', () => {
    const gaps = [makeGap('critical', 0)]
    const result = createTasks(gaps, new Set())
    expect(result[0].gap_index).toBe(0)
  })
})
