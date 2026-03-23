export interface CompletionOptions {
  /** JSON Schema for structured output. When provided, adapter MUST return valid JSON string. */
  responseSchema?: Record<string, unknown>
  temperature?: number
  maxTokens?: number
}

export interface AIProvider {
  complete(prompt: string, options?: CompletionOptions): Promise<string>
}

/** Parse structured response. Throws if invalid JSON when schema was requested. */
export function parseStructuredResponse<T>(raw: string, schema?: Record<string, unknown>): T {
  if (!schema) return raw as unknown as T
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new Error(`AI provider returned invalid JSON. Raw response: ${raw.slice(0, 200)}`)
  }
}
