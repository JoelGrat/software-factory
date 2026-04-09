// tests/lib/planning/draft-planner.test.ts
import { describe, it, expect } from 'vitest'
import { runDraftPlan } from '@/lib/planning/draft-planner'
import { MockAIProvider } from '@/lib/ai/adapters/mock'

const CHANGE = { title: 'Add user auth', intent: 'Users need to log in', type: 'feature' as const }

describe('runDraftPlan', () => {
  it('returns new_file_paths and component_names from AI response', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({
      new_file_paths: ['lib/auth/user-auth.ts', 'tests/lib/auth/user-auth.test.ts'],
      component_names: ['AuthService', 'UserRepository'],
    }))

    const result = await runDraftPlan(CHANGE, ai)
    expect(result.new_file_paths).toEqual(['lib/auth/user-auth.ts', 'tests/lib/auth/user-auth.test.ts'])
    expect(result.component_names).toEqual(['AuthService', 'UserRepository'])
  })

  it('calls AI exactly once', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({ new_file_paths: [], component_names: [] }))

    await runDraftPlan(CHANGE, ai)
    expect(ai.callCount).toBe(1)
  })

  it('returns empty arrays when AI returns empty lists', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({ new_file_paths: [], component_names: [] }))

    const result = await runDraftPlan(CHANGE, ai)
    expect(result.new_file_paths).toHaveLength(0)
    expect(result.component_names).toHaveLength(0)
  })

  it('includes the change title and intent in the prompt', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({ new_file_paths: [], component_names: [] }))

    await runDraftPlan(CHANGE, ai)
    // MockAIProvider doesn't capture prompts directly, but we can verify by setting
    // a response keyed on content that should appear in the prompt
    const ai2 = new MockAIProvider()
    ai2.setResponse('Add user auth', JSON.stringify({ new_file_paths: ['lib/x.ts'], component_names: [] }))
    ai2.setDefaultResponse(JSON.stringify({ new_file_paths: [], component_names: [] }))

    const result = await runDraftPlan(CHANGE, ai2)
    expect(result.new_file_paths).toContain('lib/x.ts')
  })
})
