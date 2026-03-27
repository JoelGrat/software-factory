// lib/ai/registry.ts
import type { AIProvider } from './provider'
import { MockAIProvider }  from './adapters/mock'
import { ClaudeAIProvider } from './adapters/claude'
import { OpenAIProvider }  from './adapters/openai'

export function getProviderByName(name: string): AIProvider {
  switch (name) {
    case 'mock':   return new MockAIProvider()
    case 'claude': return new ClaudeAIProvider()
    case 'openai': return new OpenAIProvider()
    default: throw new Error(`Unknown AI_PROVIDER: ${name}`)
  }
}

export function getProvider(): AIProvider {
  return getProviderByName(process.env.AI_PROVIDER ?? 'mock')
}
