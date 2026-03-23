import type { AIProvider, CompletionOptions } from '@/lib/ai/provider'

export class ClaudeAIProvider implements AIProvider {
  async complete(_prompt: string, _options?: CompletionOptions): Promise<string> {
    throw new Error('ClaudeAIProvider not yet implemented')
  }
}
