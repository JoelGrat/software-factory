// tests/lib/planning/prompt-builders.test.ts
import { describe, it, expect } from 'vitest'
import {
  buildArchitecturePrompt,
  buildComponentTasksPrompt,
  buildSpecPrompt,
} from '@/lib/planning/prompt-builders'
import type { ImpactedComponent, PlannerArchitecture } from '@/lib/planning/types'

const COMPONENTS: ImpactedComponent[] = [
  { componentId: 'c1', name: 'AuthService', type: 'auth', impactWeight: 1.0 },
  { componentId: 'c2', name: 'UserRepository', type: 'repository', impactWeight: 0.7 },
]

const CHANGE = { title: 'Fix auth token expiry', intent: 'Tokens expire too quickly', type: 'bug' as const }

const ARCHITECTURE: PlannerArchitecture = {
  approach: 'Extend token TTL and add refresh logic',
  branchName: 'sf/abc123-fix-auth-token',
  testApproach: 'Unit test token validation',
  estimatedFiles: 4,
  componentApproaches: {},
}

describe('buildArchitecturePrompt', () => {
  it('includes change title and intent', () => {
    const prompt = buildArchitecturePrompt(CHANGE, COMPONENTS)
    expect(prompt).toContain('Fix auth token expiry')
    expect(prompt).toContain('Tokens expire too quickly')
  })

  it('lists all component names and types', () => {
    const prompt = buildArchitecturePrompt(CHANGE, COMPONENTS)
    expect(prompt).toContain('AuthService')
    expect(prompt).toContain('auth')
    expect(prompt).toContain('UserRepository')
    expect(prompt).toContain('repository')
  })

  it('asks for branchName in JSON output', () => {
    const prompt = buildArchitecturePrompt(CHANGE, COMPONENTS)
    expect(prompt).toContain('branchName')
  })

  it('asks for component approaches by name', () => {
    const prompt = buildArchitecturePrompt(CHANGE, COMPONENTS)
    expect(prompt).toContain('componentApproaches')
  })
})

describe('buildComponentTasksPrompt', () => {
  it('includes component name and type', () => {
    const prompt = buildComponentTasksPrompt(CHANGE, COMPONENTS[0], 'Extend token TTL')
    expect(prompt).toContain('AuthService')
    expect(prompt).toContain('auth')
  })

  it('includes the approach from architecture', () => {
    const prompt = buildComponentTasksPrompt(CHANGE, COMPONENTS[0], 'Extend token TTL')
    expect(prompt).toContain('Extend token TTL')
  })

  it('includes change intent', () => {
    const prompt = buildComponentTasksPrompt(CHANGE, COMPONENTS[0], 'Extend token TTL')
    expect(prompt).toContain('Tokens expire too quickly')
  })

  it('asks for tasks array in JSON output', () => {
    const prompt = buildComponentTasksPrompt(CHANGE, COMPONENTS[0], 'Extend token TTL')
    expect(prompt).toContain('"tasks"')
  })
})

describe('buildSpecPrompt', () => {
  it('includes change title and type', () => {
    const tasks = [
      { description: 'Update token TTL config', componentId: 'c1', componentName: 'AuthService', orderIndex: 0 },
    ]
    const prompt = buildSpecPrompt(CHANGE, ARCHITECTURE, tasks)
    expect(prompt).toContain('Fix auth token expiry')
    expect(prompt).toContain('bug')
  })

  it('includes task descriptions', () => {
    const tasks = [
      { description: 'Update token TTL config', componentId: 'c1', componentName: 'AuthService', orderIndex: 0 },
    ]
    const prompt = buildSpecPrompt(CHANGE, ARCHITECTURE, tasks)
    expect(prompt).toContain('Update token TTL config')
  })

  it('includes component approach', () => {
    const tasks = [
      { description: 'Update token TTL config', componentId: 'c1', componentName: 'AuthService', orderIndex: 0 },
    ]
    const prompt = buildSpecPrompt(CHANGE, ARCHITECTURE, tasks)
    expect(prompt).toContain('Extend token TTL and add refresh logic')
  })
})
