import type { AIProvider } from './provider'
import { MockAIProvider } from './adapters/mock'
import { ClaudeAIProvider } from './adapters/claude'
import { OpenAIProvider } from './adapters/openai'

export function getProvider(): AIProvider {
  const providerName = process.env.AI_PROVIDER ?? 'mock'

  switch (providerName) {
    case 'mock':
      return new MockAIProvider()
    case 'claude':
      return new ClaudeAIProvider()
    case 'openai':
      return new OpenAIProvider()
    default:
      throw new Error(`Unknown AI_PROVIDER: ${providerName}`)
  }
}
