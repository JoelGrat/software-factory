import { describe, it, expect } from 'vitest'
import { getProvider } from '@/lib/ai/registry'
import { MockAIProvider } from '@/lib/ai/adapters/mock'

describe('AI provider registry', () => {
  it('returns MockAIProvider when AI_PROVIDER=mock', () => {
    process.env.AI_PROVIDER = 'mock'
    const provider = getProvider()
    expect(provider).toBeInstanceOf(MockAIProvider)
  })

  it('throws when AI_PROVIDER is unrecognised', () => {
    process.env.AI_PROVIDER = 'unknown-provider'
    expect(() => getProvider()).toThrow('Unknown AI_PROVIDER: unknown-provider')
  })
})
