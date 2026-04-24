import { describe, it, expect } from 'vitest'
import { analyzeFeedback } from '@/lib/feedback/feedback-analyzer'
import { MockAIProvider } from '@/lib/ai/adapters/mock'

const TASKS = [
  { id: 't1', order_index: 0, description: 'Add sidebar navigation link', dependencies: [] },
  { id: 't2', order_index: 1, description: 'Create DocsPage empty state content', dependencies: [] },
  { id: 't3', order_index: 2, description: 'Write unit tests for sidebar', dependencies: ['t1'] },
  { id: 't4', order_index: 3, description: 'Update backend API endpoints', dependencies: [] },
]

describe('analyzeFeedback', () => {
  it('returns suggestions with taskId, confidence, explanation', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({
      suggestions: [
        { taskId: 't1', confidence: 'high', explanation: 'Feedback mentions sidebar link' },
        { taskId: 't2', confidence: 'high', explanation: 'Feedback mentions docs page' },
      ],
      lowConfidence: false,
    }))

    const result = await analyzeFeedback(
      'Sidebar link should be above Settings and docs page needs empty state copy.',
      TASKS,
      ai,
    )

    expect(result.suggestions).toHaveLength(2)
    expect(result.suggestions[0].taskId).toBe('t1')
    expect(result.suggestions[0].confidence).toBe('high')
    expect(result.suggestions[0].explanation).toBeTruthy()
    expect(result.lowConfidence).toBe(false)
  })

  it('sets lowConfidence true when model signals uncertainty', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({
      suggestions: [],
      lowConfidence: true,
    }))

    const result = await analyzeFeedback('change some stuff', TASKS, ai)
    expect(result.lowConfidence).toBe(true)
    expect(result.suggestions).toHaveLength(0)
  })

  it('only returns taskIds that exist in the task list', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({
      suggestions: [
        { taskId: 't1', confidence: 'high', explanation: 'ok' },
        { taskId: 'BOGUS', confidence: 'low', explanation: 'hallucinated' },
      ],
      lowConfidence: false,
    }))

    const result = await analyzeFeedback('feedback', TASKS, ai)
    expect(result.suggestions.every(s => TASKS.some(t => t.id === s.taskId))).toBe(true)
  })
})
