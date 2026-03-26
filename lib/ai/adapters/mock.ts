// lib/ai/adapters/mock.ts
import type { AIProvider, CompletionOptions, CompletionResult } from '@/lib/ai/provider'

export class MockAIProvider implements AIProvider {
  private responses: Map<string, string> = new Map()
  private defaultResponse = '{}'
  callCount = 0

  setResponse(promptContains: string, response: string) {
    this.responses.set(promptContains, response)
  }

  setDefaultResponse(response: string) {
    this.defaultResponse = response
  }

  async complete(prompt: string, _options?: CompletionOptions): Promise<CompletionResult> {
    this.callCount++
    let content = this.defaultResponse
    for (const [key, response] of this.responses) {
      if (prompt.includes(key)) { content = response; break }
    }
    return { content, provider: 'mock', model: 'mock', inputTokens: 0, outputTokens: 0, retryCount: 0, latencyMs: 0 }
  }
}
