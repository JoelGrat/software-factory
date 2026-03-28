// lib/ai/adapters/openai.ts
import OpenAI from 'openai'
import type { AIProvider, CompletionOptions, CompletionResult } from '@/lib/ai/provider'
import { AIProviderError } from '@/lib/ai/provider'
import { repairAndParse } from '@/lib/ai/repair'

export class OpenAIProvider implements AIProvider {
  private client: OpenAI
  readonly providerName = 'openai'
  readonly modelName: string

  constructor() {
    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    this.modelName = process.env.OPENAI_MODEL ?? 'gpt-4o'
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult> {
    const maxRetries = options?.maxRetries ?? 3
    const timeout    = options?.timeout    ?? 30_000
    const startMs    = Date.now()
    let lastError: unknown
    let retryCount = 0

    const systemPrompt = options?.responseSchema
      ? `You must respond with valid JSON only. No prose, no markdown. JSON Schema: ${JSON.stringify(options.responseSchema)}`
      : 'You are a helpful requirements engineering assistant.'

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await Promise.race([
          this.client.chat.completions.create({
            model: this.modelName,
            temperature: attempt > 0 ? 0 : (options?.temperature ?? 0),
            max_tokens: options?.maxTokens ?? 4096,
            response_format: options?.responseSchema ? { type: 'json_object' } : { type: 'text' },
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: prompt },
            ],
          }),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('request timeout')), timeout)
          ),
        ])

        if (!response.choices.length) throw new Error('OpenAI returned no choices')
        const raw = response.choices[0].message.content
        if (raw === null) throw new Error('OpenAI returned null content')

        let content = raw

        if (options?.responseSchema) {
          const parsed = repairAndParse(content)
          if (parsed === null) {
            lastError = new Error('Invalid JSON — repair failed')
            retryCount = attempt + 1
            continue
          }
          content = JSON.stringify(parsed)
        }

        const usage = response.usage

        return {
          content,
          provider: this.providerName,
          model: this.modelName,
          inputTokens:  usage?.prompt_tokens     ?? 0,
          outputTokens: usage?.completion_tokens ?? 0,
          retryCount,
          latencyMs: Date.now() - startMs,
        }
      } catch (err) {
        lastError = err
        retryCount = attempt + 1
      }
    }

    throw new AIProviderError(
      `OpenAI failed after ${maxRetries + 1} attempts`,
      'unknown',
      this.providerName,
      maxRetries + 1,
      lastError
    )
  }
}
