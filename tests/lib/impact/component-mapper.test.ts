import { describe, it, expect } from 'vitest'
import { mapComponents } from '@/lib/impact/component-mapper'
import { MockAIProvider } from '@/lib/ai/adapters/mock'
import type { SupabaseClient } from '@supabase/supabase-js'

const COMPONENTS = [
  { id: 'comp-auth', name: 'AuthService', type: 'auth' },
  { id: 'comp-user', name: 'UserRepository', type: 'repository' },
  { id: 'comp-api', name: 'ProjectsAPI', type: 'api' },
]

const ASSIGNMENTS = [
  { file_id: 'file-auth-1', component_id: 'comp-auth' },
  { file_id: 'file-auth-2', component_id: 'comp-auth' },
  { file_id: 'file-user-1', component_id: 'comp-user' },
]

function makeMockDb(overrides: { components?: typeof COMPONENTS; assignments?: typeof ASSIGNMENTS } = {}): SupabaseClient {
  const components = overrides.components ?? COMPONENTS
  const assignments = overrides.assignments ?? ASSIGNMENTS

  return {
    from: (table: string) => {
      if (table === 'change_requests') {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: { project_id: 'proj1' }, error: null }),
            }),
          }),
        }
      }
      if (table === 'system_components') {
        return {
          select: () => ({
            eq: () => ({
              is: () => ({
                order: () => Promise.resolve({ data: components, error: null }),
              }),
            }),
          }),
        }
      }
      if (table === 'component_assignment') {
        return {
          select: () => ({
            in: () => Promise.resolve({ data: assignments, error: null }),
          }),
        }
      }
      return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }) }
    },
  } as unknown as SupabaseClient
}

describe('mapComponents', () => {
  it('matches components by keyword in title', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({ affected: [] }))
    const result = await mapComponents(
      'cr1',
      { title: 'Fix auth login timeout', intent: 'The login is slow', tags: [] },
      makeMockDb(),
      ai
    )
    expect(result.components.some(c => c.componentId === 'comp-auth')).toBe(true)
    const authComp = result.components.find(c => c.componentId === 'comp-auth')!
    expect(authComp.matchReason).toContain('keyword')
  })

  it('matches components by tag', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({ affected: [] }))
    const result = await mapComponents(
      'cr1',
      { title: 'Improve performance', intent: 'Too slow', tags: ['auth'] },
      makeMockDb(),
      ai
    )
    expect(result.components.some(c => c.componentId === 'comp-auth')).toBe(true)
  })

  it('uses AI to find components not matched by keyword', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({ affected: ['ProjectsAPI'] }))
    const result = await mapComponents(
      'cr1',
      { title: 'Improve project listing speed', intent: 'Slow', tags: [] },
      makeMockDb(),
      ai
    )
    expect(result.aiUsed).toBe(true)
    expect(result.components.some(c => c.componentId === 'comp-api')).toBe(true)
  })

  it('does not duplicate components from keyword and AI', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({ affected: ['AuthService'] }))
    const result = await mapComponents(
      'cr1',
      { title: 'Fix auth login', intent: 'Auth is broken', tags: [] },
      makeMockDb(),
      ai
    )
    const authMatches = result.components.filter(c => c.componentId === 'comp-auth')
    expect(authMatches).toHaveLength(1)
  })

  it('returns seed file IDs from component assignments', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({ affected: [] }))
    const result = await mapComponents(
      'cr1',
      { title: 'Fix auth login', intent: 'Auth broken', tags: [] },
      makeMockDb(),
      ai
    )
    expect(result.seedFileIds).toContain('file-auth-1')
    expect(result.seedFileIds).toContain('file-auth-2')
  })

  it('handles empty component list gracefully', async () => {
    const ai = new MockAIProvider()
    const result = await mapComponents(
      'cr1',
      { title: 'Anything', intent: 'Whatever', tags: [] },
      makeMockDb({ components: [] }),
      ai
    )
    expect(result.components).toHaveLength(0)
    expect(result.seedFileIds).toHaveLength(0)
    expect(result.aiUsed).toBe(false)
    expect(ai.callCount).toBe(0)
  })

  it('handles malformed AI JSON gracefully', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse('not valid json')
    const result = await mapComponents(
      'cr1',
      { title: 'Some change', intent: 'Something', tags: [] },
      makeMockDb(),
      ai
    )
    // Should not throw — AI errors are swallowed
    expect(result).toBeDefined()
  })
})
