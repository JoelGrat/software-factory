import { describe, it, expect, vi } from 'vitest'

// Mock SDK constructors so the adapters can be instantiated without real API keys
vi.mock('@anthropic-ai/sdk', () => {
  const MockAnthropic = vi.fn(function (this: Record<string, unknown>) {
    this.messages = { create: vi.fn() }
  })
  return { default: MockAnthropic }
})

vi.mock('openai', () => {
  const MockOpenAI = vi.fn(function (this: Record<string, unknown>) {
    this.chat = { completions: { create: vi.fn() } }
  })
  return { default: MockOpenAI }
})

import { ClaudeAIProvider } from '@/lib/ai/adapters/claude'
import { OpenAIProvider } from '@/lib/ai/adapters/openai'
import type { AIProvider } from '@/lib/ai/provider'

describe('Adapter contracts', () => {
  it('ClaudeAIProvider implements AIProvider interface', () => {
    const provider: AIProvider = new ClaudeAIProvider()
    expect(typeof provider.complete).toBe('function')
  })

  it('OpenAIProvider implements AIProvider interface', () => {
    const provider: AIProvider = new OpenAIProvider()
    expect(typeof provider.complete).toBe('function')
  })
})
