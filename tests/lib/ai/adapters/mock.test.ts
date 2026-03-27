import { describe, it, expect } from 'vitest'
import { MockAIProvider } from '@/lib/ai/adapters/mock'

describe('MockAIProvider', () => {
  it('returns CompletionResult with default response', async () => {
    const provider = new MockAIProvider()
    const result = await provider.complete('any prompt')
    expect(result.content).toBe('{}')
    expect(result.provider).toBe('mock')
    expect(result.model).toBe('mock')
    expect(result.inputTokens).toBe(0)
    expect(result.outputTokens).toBe(0)
    expect(result.retryCount).toBe(0)
    expect(result.latencyMs).toBe(0)
  })

  it('matches on prompt substring', async () => {
    const provider = new MockAIProvider()
    provider.setResponse('GAPS', '{"gaps": []}')
    const result = await provider.complete('detect GAPS in this')
    expect(result.content).toBe('{"gaps": []}')
  })

  it('falls through to default when no key matches', async () => {
    const provider = new MockAIProvider()
    provider.setResponse('GAPS', '{"gaps": []}')
    const result = await provider.complete('unrelated prompt')
    expect(result.content).toBe('{}')
  })

  it('tracks call count', async () => {
    const provider = new MockAIProvider()
    await provider.complete('a')
    await provider.complete('b')
    expect(provider.callCount).toBe(2)
  })

  it('setDefaultResponse overrides default', async () => {
    const provider = new MockAIProvider()
    provider.setDefaultResponse('{"ok": true}')
    const result = await provider.complete('anything')
    expect(result.content).toBe('{"ok": true}')
  })
})
