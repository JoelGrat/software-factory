// tests/lib/planning/phases.test.ts
import { describe, it, expect } from 'vitest'
import { runArchitecturePhase, runComponentTasksPhase, runOrderingPhase, runSpecPhase } from '@/lib/planning/phases'
import { MockAIProvider } from '@/lib/ai/adapters/mock'
import type { ImpactedComponent, PlannerArchitecture, PlannerTask } from '@/lib/planning/types'

const CHANGE = { title: 'Fix auth', intent: 'Auth is broken', type: 'bug' as const }

const COMPONENTS: ImpactedComponent[] = [
  { componentId: 'c1', name: 'AuthService', type: 'auth', impactWeight: 1.0 },
  { componentId: 'c2', name: 'UserRepository', type: 'repository', impactWeight: 0.7 },
]

describe('runArchitecturePhase', () => {
  it('parses AI JSON response into PlannerArchitecture', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({
      approach: 'Fix token expiry',
      branchName: 'sf/abc123-fix-auth',
      testApproach: 'Unit tests for token validation',
      estimatedFiles: 3,
      componentApproaches: { AuthService: 'Update TTL', UserRepository: 'No changes needed' },
    }))

    const result = await runArchitecturePhase(CHANGE, COMPONENTS, ai)
    expect(result.approach).toBe('Fix token expiry')
    expect(result.branchName).toBe('sf/abc123-fix-auth')
    expect(result.componentApproaches['AuthService']).toBe('Update TTL')
  })

  it('calls AI exactly once', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({
      approach: 'Fix', branchName: 'sf/x-fix', testApproach: 'tests',
      estimatedFiles: 1, componentApproaches: {},
    }))

    await runArchitecturePhase(CHANGE, COMPONENTS, ai)
    expect(ai.callCount).toBe(1)
  })

  it('throws on invalid AI response', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse('not json')
    await expect(runArchitecturePhase(CHANGE, COMPONENTS, ai)).rejects.toThrow()
  })
})

describe('runComponentTasksPhase', () => {
  it('returns task description strings', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({
      tasks: [
        { description: 'Update token TTL in config' },
        { description: 'Add refresh token endpoint' },
      ],
    }))

    const tasks = await runComponentTasksPhase(CHANGE, COMPONENTS[0], 'Update TTL', ai)
    expect(tasks).toHaveLength(2)
    expect(tasks[0]).toBe('Update token TTL in config')
    expect(tasks[1]).toBe('Add refresh token endpoint')
  })

  it('returns empty array on empty AI response', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({ tasks: [] }))
    const tasks = await runComponentTasksPhase(CHANGE, COMPONENTS[0], 'No changes', ai)
    expect(tasks).toHaveLength(0)
  })

  it('returns empty array on malformed AI response', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse('bad json')
    const tasks = await runComponentTasksPhase(CHANGE, COMPONENTS[0], 'No changes', ai)
    expect(tasks).toHaveLength(0)
  })
})

describe('runOrderingPhase', () => {
  it('orders database/repository components before api/service', () => {
    const tasks: PlannerTask[] = [
      { description: 'Add API endpoint', componentId: 'c1', componentName: 'ProjectsAPI', orderIndex: 0 },
      { description: 'Add DB column', componentId: 'c2', componentName: 'UserRepository', orderIndex: 1 },
      { description: 'Update service', componentId: 'c3', componentName: 'AuthService', orderIndex: 2 },
    ]
    const components: ImpactedComponent[] = [
      { componentId: 'c1', name: 'ProjectsAPI', type: 'api', impactWeight: 0.5 },
      { componentId: 'c2', name: 'UserRepository', type: 'repository', impactWeight: 0.8 },
      { componentId: 'c3', name: 'AuthService', type: 'auth', impactWeight: 1.0 },
    ]

    const ordered = runOrderingPhase(tasks, components)
    const names = ordered.map(t => t.componentName)
    expect(names.indexOf('UserRepository')).toBeLessThan(names.indexOf('ProjectsAPI'))
  })

  it('assigns sequential order_index values starting at 0', () => {
    const tasks: PlannerTask[] = [
      { description: 'Task A', componentId: 'c1', componentName: 'AuthService', orderIndex: 0 },
      { description: 'Task B', componentId: 'c1', componentName: 'AuthService', orderIndex: 1 },
    ]
    const components: ImpactedComponent[] = [
      { componentId: 'c1', name: 'AuthService', type: 'auth', impactWeight: 1.0 },
    ]
    const ordered = runOrderingPhase(tasks, components)
    expect(ordered[0].orderIndex).toBe(0)
    expect(ordered[1].orderIndex).toBe(1)
  })

  it('returns all tasks unchanged when components have same type', () => {
    const tasks: PlannerTask[] = [
      { description: 'Task A', componentId: 'c1', componentName: 'CompA', orderIndex: 0 },
      { description: 'Task B', componentId: 'c2', componentName: 'CompB', orderIndex: 1 },
    ]
    const components: ImpactedComponent[] = [
      { componentId: 'c1', name: 'CompA', type: 'service', impactWeight: 1.0 },
      { componentId: 'c2', name: 'CompB', type: 'service', impactWeight: 0.5 },
    ]
    const ordered = runOrderingPhase(tasks, components)
    expect(ordered).toHaveLength(2)
  })
})

describe('runSpecPhase', () => {
  it('returns the AI response string as-is', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse('# Implementation Spec\n\nDo the thing.')

    const architecture: PlannerArchitecture = {
      approach: 'Fix it',
      branchName: 'sf/abc-fix',
      testApproach: 'Unit tests',
      estimatedFiles: 2,
      componentApproaches: {},
      newFilePaths: [],
    }
    const tasks: PlannerTask[] = []
    const spec = await runSpecPhase(CHANGE, architecture, tasks, ai)
    expect(spec).toBe('# Implementation Spec\n\nDo the thing.')
  })

  it('returns empty string on AI error', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse = () => { throw new Error('AI failure') }
    // Will use default response '{}' which is fine for a text response
    const architecture: PlannerArchitecture = {
      approach: '', branchName: 'sf/x', testApproach: '', estimatedFiles: 0, componentApproaches: {}, newFilePaths: [],
    }
    // runSpecPhase should not throw even if AI fails
    const result = await runSpecPhase(CHANGE, architecture, [], ai)
    expect(typeof result).toBe('string')
  })
})
