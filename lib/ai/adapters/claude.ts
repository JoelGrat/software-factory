// lib/ai/adapters/claude.ts
import Anthropic from '@anthropic-ai/sdk'
import type { AIProvider, CompletionOptions, CompletionResult } from '@/lib/ai/provider'
import { AIProviderError } from '@/lib/ai/provider'
import { repairAndParse } from '@/lib/ai/repair'

export class ClaudeAIProvider implements AIProvider {
  private client: Anthropic
  readonly providerName = 'claude'
  readonly modelName: string

  constructor() {
    this.client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
    this.modelName = process.env.CLAUDE_MODEL ?? 'claude-opus-4-6'
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult> {
    const maxRetries = options?.maxRetries ?? 3
    const timeout    = options?.timeout    ?? 120_000
    const startMs    = Date.now()
    let lastError: unknown
    let retryCount = 0

    const systemPrompt = options?.responseSchema
      ? `You must respond with valid JSON only. No prose, no markdown. JSON Schema: ${JSON.stringify(options.responseSchema)}`
      : 'You are a helpful requirements engineering assistant.'

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const message = await Promise.race([
          this.client.messages.create({
            model: this.modelName,
            max_tokens: options?.maxTokens ?? 4096,
            temperature: attempt > 0 ? 0 : (options?.temperature ?? 0),
            system: systemPrompt,
            messages: [{ role: 'user', content: prompt }],
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('request timeout')), timeout)
          ),
        ])

        const block = message.content[0]
        if (block.type !== 'text') throw new Error('Unexpected Claude response block type')

        let content = block.text

        // JSON repair when schema was requested
        if (options?.responseSchema) {
          const parsed = repairAndParse(content)
          if (parsed === null) {
            lastError = new Error('Invalid JSON — repair failed')
            retryCount = attempt + 1
            continue
          }
          content = JSON.stringify(parsed)
        }

        return {
          content,
          provider: this.providerName,
          model: this.modelName,
          inputTokens:  message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          retryCount,
          latencyMs: Date.now() - startMs,
        }
      } catch (err) {
        lastError = err
        retryCount = attempt + 1
      }
    }

    throw new AIProviderError(
      `Claude failed after ${maxRetries + 1} attempts`,
      'unknown',
      this.providerName,
      maxRetries + 1,
      lastError
    )
  }
}
