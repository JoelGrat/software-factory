import { describe, it, expect, afterEach } from 'vitest'
import { getProvider } from '@/lib/ai/registry'
import { MockAIProvider } from '@/lib/ai/adapters/mock'
import { parseStructuredResponse } from '@/lib/ai/provider'

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
})

describe('parseStructuredResponse', () => {
  it('returns raw string when no schema provided', () => {
    const input = 'hello world'
    const result = parseStructuredResponse(input)
    expect(result).toBe(input)
  })

  it('throws on invalid JSON when schema is provided', () => {
    expect(() => parseStructuredResponse('not-json', {})).toThrow('invalid JSON')
  })
})
