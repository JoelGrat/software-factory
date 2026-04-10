// tests/lib/planning/task-validator.test.ts
import { describe, it, expect } from 'vitest'
import { validateTasks } from '@/lib/planning/task-validator'
import type { ValidatableTask, ImpactedComponentForValidation } from '@/lib/planning/task-validator'

const COMPONENTS: ImpactedComponentForValidation[] = [
  { componentId: 'c1', weight: 1.0 },
  { componentId: 'c2', weight: 0.8 },
  { componentId: 'c3', weight: 0.6 },
]

const GOOD_TASKS: ValidatableTask[] = [
  { componentId: 'c1', componentName: 'AuthService', description: 'Implement retry logic in AuthService auth.service.ts', orderIndex: 0 },
  { componentId: 'c2', componentName: 'UserRepo', description: 'Update UserRepo to handle new fields user.repository.ts', orderIndex: 1 },
  { componentId: 'c3', componentName: 'ApiGateway', description: 'Fix routing in ApiGateway api.gateway.ts', orderIndex: 2 },
  { componentId: 'c1', componentName: 'AuthService', description: 'Add tests for AuthService in auth.service.spec.ts', orderIndex: 3, newFilePath: 'auth.service.spec.ts' },
]

describe('validateTasks', () => {
  it('passes a valid task set', () => {
    const result = validateTasks(GOOD_TASKS, COMPONENTS, new Set(), new Set())
    expect(result.passed).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('fails on empty task list', () => {
    const result = validateTasks([], COMPONENTS, new Set(), new Set())
    expect(result.passed).toBe(false)
    expect(result.errors[0]).toMatch(/no tasks/i)
  })

  it('fails on orphan task (no component and no file path)', () => {
    const tasks: ValidatableTask[] = [
      ...GOOD_TASKS,
      { componentId: null, componentName: 'General', description: 'Do something general', orderIndex: 4 },
    ]
    const result = validateTasks(tasks, COMPONENTS, new Set(), new Set())
    expect(result.passed).toBe(false)
    expect(result.errors.some(e => /orphan/i.test(e))).toBe(true)
  })

  it('fails when top 3 components not covered and weight < 80%', () => {
    const tasks: ValidatableTask[] = [
      { componentId: 'c1', componentName: 'AuthService', description: 'Implement changes in AuthService auth.service.ts', orderIndex: 0 },
      { componentId: 'c1', componentName: 'AuthService', description: 'Add tests for AuthService in auth.service.spec.ts', orderIndex: 1, newFilePath: 'auth.service.spec.ts' },
    ]
    const result = validateTasks(tasks, COMPONENTS, new Set(), new Set())
    expect(result.passed).toBe(false)
    expect(result.errors.some(e => /coverage/i.test(e))).toBe(true)
  })

  it('fails when no quality test task exists', () => {
    const noTestTasks: ValidatableTask[] = GOOD_TASKS.filter(t => !t.newFilePath)
    const result = validateTasks(noTestTasks, COMPONENTS, new Set(), new Set())
    expect(result.passed).toBe(false)
    expect(result.errors.some(e => /test task/i.test(e))).toBe(true)
  })

  it('fails on duplicate tasks (same component + action type + file)', () => {
    const tasks: ValidatableTask[] = [
      ...GOOD_TASKS,
      { componentId: 'c1', componentName: 'AuthService', description: 'Add retry to AuthService in auth.service.ts', orderIndex: 5 },
    ]
    const result = validateTasks(tasks, COMPONENTS, new Set(), new Set())
    expect(result.passed).toBe(false)
    expect(result.errors.some(e => /duplicate/i.test(e))).toBe(true)
  })

  it('adds warning (not error) for 1 unknown component ref', () => {
    const tasks: ValidatableTask[] = [
      ...GOOD_TASKS,
      { componentId: 'unknown-comp', componentName: 'Phantom', description: 'Implement changes in Phantom phantom.ts', orderIndex: 5 },
    ]
    const result = validateTasks(tasks, COMPONENTS, new Set(), new Set())
    expect(result.warnings.some(w => /not in impact/i.test(w))).toBe(true)
    // Should still pass if only 1 unknown ref
    expect(result.passed).toBe(true)
  })

  it('fails (not just warns) for >1 unknown component refs', () => {
    const tasks: ValidatableTask[] = [
      ...GOOD_TASKS,
      { componentId: 'unknown-1', componentName: 'Phantom1', description: 'Implement changes in Phantom1 phantom1.ts', orderIndex: 5 },
      { componentId: 'unknown-2', componentName: 'Phantom2', description: 'Update Phantom2 to fix phantom2.ts', orderIndex: 6 },
    ]
    const result = validateTasks(tasks, COMPONENTS, new Set(), new Set())
    expect(result.passed).toBe(false)
    expect(result.errors.some(e => /hallucinated/i.test(e))).toBe(true)
  })

  it('does not flag unknown component ref when task creates a planned new file', () => {
    const tasks: ValidatableTask[] = [
      ...GOOD_TASKS,
      { componentId: 'new-comp', componentName: 'NewThing', description: 'Scaffold new module new-thing.ts', orderIndex: 5, newFilePath: 'new-thing.ts' },
    ]
    const result = validateTasks(tasks, COMPONENTS, new Set(), new Set(['new-thing.ts']))
    expect(result.warnings).toHaveLength(0)
    expect(result.passed).toBe(true)
  })
})
