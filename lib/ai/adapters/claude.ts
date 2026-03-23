import Anthropic from '@anthropic-ai/sdk'
import type { AIProvider, CompletionOptions } from '@/lib/ai/provider'

export class ClaudeAIProvider implements AIProvider {
  private client: Anthropic

  constructor() {
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    })
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<string> {
    const systemPrompt = options?.responseSchema
      ? `You must respond with valid JSON only. No prose, no markdown. JSON Schema: ${JSON.stringify(options.responseSchema)}`
      : 'You are a helpful requirements engineering assistant.'

    const message = await this.client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: options?.maxTokens ?? 4096,
      temperature: options?.temperature ?? 0,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
    })

    const block = message.content[0]
    if (block.type !== 'text') throw new Error('Unexpected Claude response type')
    return block.text
  }
}
