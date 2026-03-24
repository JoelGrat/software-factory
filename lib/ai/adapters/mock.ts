import type { AIProvider, CompletionOptions } from '@/lib/ai/provider'

export class MockAIProvider implements AIProvider {
  private responses: Map<string, string> = new Map()
  private defaultResponse = '{}'

  /** Pre-program a response for a prompt containing the given substring. */
  setResponse(promptContains: string, response: string) {
    this.responses.set(promptContains, response)
  }

  setDefaultResponse(response: string) {
    this.defaultResponse = response
  }

  async complete(prompt: string, _options?: CompletionOptions): Promise<string> {
    for (const [key, response] of this.responses) {
      if (prompt.includes(key)) return response
    }
    return this.defaultResponse
  }
}
