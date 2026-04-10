// tests/lib/planning/draft-planner.test.ts
import { describe, it, expect } from 'vitest'
import { runDraftPlan } from '@/lib/planning/draft-planner'
import { MockAIProvider } from '@/lib/ai/adapters/mock'

const CHANGE = { title: 'Add user auth', intent: 'Users need to log in', type: 'feature' as const }

describe('runDraftPlan', () => {
  it('returns new_file_paths and component_names from AI response', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({
      new_file_paths: ['lib/auth/user-auth.ts'],
      component_names: ['AuthService'],
      assumptions: ['AuthService is the entry point'],
      confidence: 0.85,
    }))
    const result = await runDraftPlan(CHANGE, ai)
    expect(result.new_file_paths).toEqual(['lib/auth/user-auth.ts'])
    expect(result.component_names).toEqual(['AuthService'])
  })

  it('returns assumptions from AI response', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({
      new_file_paths: [],
      component_names: ['AuthService'],
      assumptions: ['Assumes JWT is already configured'],
      confidence: 0.7,
    }))
    const result = await runDraftPlan(CHANGE, ai)
    expect(result.assumptions).toEqual(['Assumes JWT is already configured'])
  })

  it('defaults assumptions to empty array when AI omits it', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({ new_file_paths: [], component_names: [] }))
    const result = await runDraftPlan(CHANGE, ai)
    expect(result.assumptions).toEqual([])
  })

  it('defaults confidence to 0.5 when AI omits it', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({ new_file_paths: [], component_names: [] }))
    const result = await runDraftPlan(CHANGE, ai)
    expect(result.confidence).toBe(0.5)
  })

  it('clamps confidence to [0, 1]', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({ new_file_paths: [], component_names: [], confidence: 1.8 }))
    const result = await runDraftPlan(CHANGE, ai)
    expect(result.confidence).toBe(1)
  })

  it('clamps confidence below 0 to 0', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({ new_file_paths: [], component_names: [], confidence: -0.3 }))
    const result = await runDraftPlan(CHANGE, ai)
    expect(result.confidence).toBe(0)
  })

  it('calls AI exactly once', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({ new_file_paths: [], component_names: [] }))
    await runDraftPlan(CHANGE, ai)
    expect(ai.callCount).toBe(1)
  })
})
