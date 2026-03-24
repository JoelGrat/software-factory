import { describe, it, expect } from 'vitest'
import { generateQuestions } from '@/lib/requirements/question-generator'
import { MockAIProvider } from '@/lib/ai/adapters/mock'
import type { DetectedGap } from '@/lib/requirements/gap-detector'

const makeGap = (i: number, severity: 'critical' | 'major' | 'minor' = 'critical'): DetectedGap => ({
  item_id: null,
  severity,
  category: 'missing',
  description: `Gap ${i}`,
  source: 'rule',
  rule_id: 'x',
  priority_score: severity === 'critical' ? 9 : severity === 'major' ? 6 : 1,
  confidence: 100,
  question_generated: false,
})

describe('generateQuestions', () => {
  it('generates one question per top-10 non-merged gaps', async () => {
    const mock = new MockAIProvider()
    mock.setDefaultResponse(JSON.stringify({ question_text: 'Who approves?', target_role: 'po' }))
    const gaps = Array.from({ length: 12 }, (_, i) => makeGap(i))
    const mergedIndices = new Set<number>()
    const result = await generateQuestions(gaps, mergedIndices, [], mock)
    expect(result).toHaveLength(10)
  })

  it('skips merged gap indices', async () => {
    const mock = new MockAIProvider()
    mock.setDefaultResponse(JSON.stringify({ question_text: 'Who approves?', target_role: 'po' }))
    const gaps: DetectedGap[] = [makeGap(0), makeGap(1)]
    const mergedIndices = new Set([1]) // gap at index 1 is merged
    const result = await generateQuestions(gaps, mergedIndices, [], mock)
    expect(result).toHaveLength(1)
  })

  it('returns question with correct shape', async () => {
    const mock = new MockAIProvider()
    mock.setDefaultResponse(JSON.stringify({ question_text: 'Who approves requests?', target_role: 'ba' }))
    const result = await generateQuestions([makeGap(0)], new Set(), [], mock)
    expect(result[0]).toMatchObject({
      question_text: 'Who approves requests?',
      target_role: 'ba',
      gap_index: 0,
    })
  })
})
