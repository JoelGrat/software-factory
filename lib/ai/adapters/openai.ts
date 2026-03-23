import type { AIProvider, CompletionOptions } from '@/lib/ai/provider'

export class OpenAIProvider implements AIProvider {
  async complete(_prompt: string, _options?: CompletionOptions): Promise<string> {
    throw new Error('OpenAIProvider not yet implemented')
  }
}
