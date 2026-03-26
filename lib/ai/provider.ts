// lib/ai/provider.ts

export interface CompletionOptions {
  /** JSON Schema for structured output. When provided, adapter MUST return valid JSON string. */
  responseSchema?: Record<string, unknown>
  temperature?: number
  maxTokens?: number
  /** Request timeout in milliseconds. Default: 30000 */
  timeout?: number
  /** Max retry attempts on JSON failure or transient error. Default: 3 */
  maxRetries?: number
  /** Provider ID to try if primary provider exhausts retries */
  fallbackProvider?: string
}

export interface CompletionResult {
  content: string
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  retryCount: number
  latencyMs: number
}

export interface AIProvider {
  complete(prompt: string, options?: CompletionOptions): Promise<CompletionResult>
}

export class AIProviderError extends Error {
  constructor(
    message: string,
    public readonly step: string,
    public readonly provider: string,
    public readonly attemptCount: number,
    public readonly lastError: unknown
  ) {
    super(message)
    this.name = 'AIProviderError'
  }
}
