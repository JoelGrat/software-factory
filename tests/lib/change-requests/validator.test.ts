// tests/lib/change-requests/validator.test.ts
import { describe, it, expect } from 'vitest'
import {
  validateCreateChangeRequest,
  runContentValidation,
  computeSuspicionFlags,
} from '@/lib/change-requests/validator'
import { MockAIProvider } from '@/lib/ai/adapters/mock'

describe('validateCreateChangeRequest — structural (Stage 1)', () => {
  it('rejects missing title', () => {
    const result = validateCreateChangeRequest({ intent: 'Add retry to AuthService login endpoint', type: 'feature' })
    expect(result.valid).toBe(false)
  })

  it('rejects title shorter than 10 chars', () => {
    const result = validateCreateChangeRequest({ title: 'Fix auth', intent: 'Add retry to AuthService login endpoint with exponential backoff', type: 'feature' })
    expect(result.valid).toBe(false)
    expect((result as any).error).toMatch(/10/)
  })

  it('rejects intent shorter than 30 chars', () => {
    const result = validateCreateChangeRequest({ title: 'Fix auth login', intent: 'update login', type: 'feature' })
    expect(result.valid).toBe(false)
  })

  it('rejects vague title phrases', () => {
    const result = validateCreateChangeRequest({ title: 'refactor code', intent: 'Add retry to AuthService login endpoint with exponential backoff', type: 'refactor' })
    expect(result.valid).toBe(false)
  })

  it('rejects intent with fewer than 2 action verbs', () => {
    const result = validateCreateChangeRequest({ title: 'Auth service retry', intent: 'The login endpoint needs some attention for better reliability', type: 'feature' })
    expect(result.valid).toBe(false)
  })

  it('rejects intent with no technical noun and fewer than 6 words', () => {
    const result = validateCreateChangeRequest({ title: 'Fix login thing', intent: 'Make login work better and update stuff', type: 'bug' })
    expect(result.valid).toBe(false)
  })

  it('accepts valid change with technical noun', () => {
    const result = validateCreateChangeRequest({
      title: 'Add login retry logic',
      intent: 'Add exponential backoff retry to AuthService login endpoint to handle transient failures',
      type: 'feature',
    })
    expect(result.valid).toBe(true)
  })

  it('accepts valid change with multi-word intent (>5 words, 2+ verbs)', () => {
    const result = validateCreateChangeRequest({
      title: 'Fix and update user registration flow',
      intent: 'Fix the broken registration form and update validation to handle duplicate emails correctly',
      type: 'bug',
    })
    expect(result.valid).toBe(true)
  })
})

describe('computeSuspicionFlags', () => {
  it('flags short intent', () => {
    expect(computeSuspicionFlags('add button')).toBeGreaterThanOrEqual(1)
  })

  it('flags intent with generic words', () => {
    expect(computeSuspicionFlags('update the system feature to work better')).toBeGreaterThanOrEqual(1)
  })

  it('returns 0 for clear, specific intent', () => {
    const intent = 'Add retry logic with exponential backoff to the AuthService login endpoint to handle transient network failures'
    expect(computeSuspicionFlags(intent)).toBe(0)
  })
})

describe('runContentValidation — Stage 2 AI scoring', () => {
  it('accepts high-scoring intent', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({ score: 0.9, reason: 'Clear and specific' }))
    const result = await runContentValidation('Add retry logic', 'Add exponential backoff to login endpoint', 'feature', ai)
    expect(result.valid).toBe(true)
  })

  it('rejects low-scoring intent (below 0.65)', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({ score: 0.4, reason: 'Scope is unclear' }))
    const result = await runContentValidation('Update the thing', 'Make it work better somehow', 'feature', ai)
    expect(result.valid).toBe(false)
    expect((result as any).reasons).toContain('AI specificity score 0.4: Scope is unclear')
  })

  it('returns structured rejection response', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({ score: 0.3, reason: 'No specific component named' }))
    const result = await runContentValidation('Update login', 'Make login better for users', 'feature', ai)
    expect(result).toMatchObject({
      valid: false,
      error: 'INVALID_CHANGE_REQUEST',
      reasons: expect.any(Array),
      suggestion: expect.any(String),
    })
  })

  it('fails safe if AI returns malformed output (reject)', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse('not json at all')
    const result = await runContentValidation('Update login endpoint', 'Update login endpoint', 'feature', ai)
    expect(result.valid).toBe(false)
  })
})
