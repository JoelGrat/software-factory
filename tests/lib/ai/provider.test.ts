import { describe, it, expect, afterEach } from 'vitest'
import { getProvider } from '@/lib/ai/registry'
import { MockAIProvider } from '@/lib/ai/adapters/mock'

describe('AI provider registry', () => {
  afterEach(() => {
    delete process.env.AI_PROVIDER
  })

  it('returns MockAIProvider when AI_PROVIDER=mock', () => {
    process.env.AI_PROVIDER = 'mock'
    const provider = getProvider()
    expect(provider).toBeInstanceOf(MockAIProvider)
  })

  it('throws when AI_PROVIDER is unrecognised', () => {
    process.env.AI_PROVIDER = 'unknown-provider'
    expect(() => getProvider()).toThrow('Unknown AI_PROVIDER: unknown-provider')
  })

  it('complete() returns a CompletionResult with provider=mock', async () => {
    process.env.AI_PROVIDER = 'mock'
    const provider = getProvider()
    const result = await provider.complete('hello')
    expect(result.provider).toBe('mock')
    expect(typeof result.content).toBe('string')
    expect(typeof result.latencyMs).toBe('number')
  })
})
