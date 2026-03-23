import OpenAI from 'openai'
import type { AIProvider, CompletionOptions } from '@/lib/ai/provider'

export class OpenAIProvider implements AIProvider {
  private client: OpenAI

  constructor() {
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    })
  }

  async complete(prompt: string, options?: CompletionOptions): Promise<string> {
    const systemPrompt = options?.responseSchema
      ? `You must respond with valid JSON only. No prose, no markdown. JSON Schema: ${JSON.stringify(options.responseSchema)}`
      : 'You are a helpful requirements engineering assistant.'

    const response = await this.client.chat.completions.create({
      model: process.env.OPENAI_MODEL ?? 'gpt-4o',
      temperature: options?.temperature ?? 0,
      max_tokens: options?.maxTokens ?? 4096,
      response_format: options?.responseSchema ? { type: 'json_object' } : { type: 'text' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
    })

    if (!response.choices.length) throw new Error('OpenAI returned no choices')
    const content = response.choices[0].message.content
    if (content === null) throw new Error('OpenAI returned null content (possible tool_calls or content filter response)')
    return content
  }
}
