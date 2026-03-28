import { describe, it, expect } from 'vitest'
import { runRequirementsLoop } from '@/lib/agent/agents/requirements.agent'
import { MockAIProvider } from '@/lib/ai/adapters/mock'

const baseItems = [
  { type: 'functional', title: 'Login', description: 'Users can log in', priority: 'high', source_text: 'Users can log in', nfr_category: null },
]

describe('runRequirementsLoop', () => {
  it('returns items when confidence >= 80 on first iteration', async () => {
    const mock = new MockAIProvider()
    mock.setDefaultResponse(JSON.stringify({ items: baseItems, critique: [], confidence: 90 }))
    const result = await runRequirementsLoop('Users can log in', mock)
    expect(result).toHaveLength(1)
    expect(mock.callCount).toBe(1)
  })

  it('iterates when confidence < 80', async () => {
    const mock = new MockAIProvider()
    let call = 0
    const original = mock.complete.bind(mock)
    mock.complete = async (prompt: string, opts?: unknown) => {
      call++
      if (call >= 2) {
        return { ...(await original(prompt, opts as Parameters<typeof original>[1])), content: JSON.stringify({ items: baseItems, critique: [], confidence: 85 }) }
      }
      return { ...(await original(prompt, opts as Parameters<typeof original>[1])), content: JSON.stringify({ items: baseItems, critique: ['Missing error handling'], confidence: 60 }) }
    }
    const result = await runRequirementsLoop('some text', mock)
    expect(call).toBeGreaterThanOrEqual(2)
    expect(result).toHaveLength(1)
  })

  it('returns items after max iterations even if confidence stays low', async () => {
    const mock = new MockAIProvider()
    mock.setDefaultResponse(JSON.stringify({ items: baseItems, critique: ['always low'], confidence: 50 }))
    const result = await runRequirementsLoop('text', mock)
    expect(result).toHaveLength(1)
    expect(mock.callCount).toBeLessThanOrEqual(3)
  })
})
