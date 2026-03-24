import { describe, it, expect } from 'vitest'
import { MockAIProvider } from '@/lib/ai/adapters/mock'

describe('MockAIProvider', () => {
  it('returns default response when no match', async () => {
    const provider = new MockAIProvider()
    provider.setDefaultResponse('hello')
    const result = await provider.complete('any prompt')
    expect(result).toBe('hello')
  })

  it('returns matched response when prompt contains key', async () => {
    const provider = new MockAIProvider()
    provider.setResponse('parse requirements', '{"items":[]}')
    const result = await provider.complete('please parse requirements from this text')
    expect(result).toBe('{"items":[]}')
  })

  it('returns first match when multiple keys match', async () => {
    const provider = new MockAIProvider()
    provider.setResponse('foo', 'response-foo')
    provider.setResponse('bar', 'response-bar')
    const result = await provider.complete('foo bar baz')
    expect(result).toBe('response-foo')
  })
})
