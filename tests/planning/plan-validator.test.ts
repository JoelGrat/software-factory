import { describe, it, expect } from 'vitest'
import { validateSpecInput, validatePlanOutput } from '@/lib/planning/plan-validator'
import type { ChangeSpec, DetailedPlan } from '@/lib/planning/types'

const validSpec: ChangeSpec = {
  problem: 'The planner produces flat tasks',
  goals: ['Replace flat tasks with phases and substeps'],
  architecture: 'New pipeline with 6 stages',
  constraints: ['Must not break existing UI'],
  out_of_scope: ['Execution pipeline changes'],
}

const validPlan: DetailedPlan = {
  schema_version: 1,
  planner_version: 1,
  goal: 'Build new planner',
  phases: [{
    id: 'phase_1',
    title: 'Foundation',
    depends_on: [],
    tasks: [{
      id: 'task_1',
      title: 'Write migration',
      type: 'database',
      files: ['supabase/migrations/025_planning_refactor.sql'],
      depends_on: [],
      substeps: [{ id: 'step_1', action: 'write_file', target: 'supabase/migrations/025_planning_refactor.sql' }],
      validation: [{ type: 'command', command: 'supabase db push' }],
      expected_result: 'Migration applied',
    }],
  }],
}

describe('validateSpecInput', () => {
  it('passes a valid spec', () => {
    const result = validateSpecInput(validSpec)
    expect(result.passed).toBe(true)
    expect(result.diagnostics.issues).toHaveLength(0)
  })

  it('fails when problem is empty', () => {
    const result = validateSpecInput({ ...validSpec, problem: '' })
    expect(result.passed).toBe(false)
    expect(result.diagnostics.issues).toContain('spec.problem is empty')
  })

  it('fails when goals is empty array', () => {
    const result = validateSpecInput({ ...validSpec, goals: [] })
    expect(result.passed).toBe(false)
    expect(result.diagnostics.issues.some(i => i.includes('goals'))).toBe(true)
  })

  it('caps issues at 10 and sets truncated flag', () => {
    const bad: ChangeSpec = { problem: '', goals: [], architecture: '', constraints: [], out_of_scope: null as any }
    const result = validateSpecInput(bad)
    expect(result.diagnostics.issues.length).toBeLessThanOrEqual(10)
  })
})

describe('validatePlanOutput', () => {
  it('passes a valid plan', () => {
    const result = validatePlanOutput(validPlan)
    expect(result.passed).toBe(true)
  })

  it('fails when plan has no phases', () => {
    const result = validatePlanOutput({ ...validPlan, phases: [] })
    expect(result.passed).toBe(false)
    expect(result.diagnostics.issues[0]).toContain('no phases')
  })

  it('fails when a phase has no tasks', () => {
    const plan: DetailedPlan = { ...validPlan, phases: [{ ...validPlan.phases[0], tasks: [] }] }
    const result = validatePlanOutput(plan)
    expect(result.passed).toBe(false)
    expect(result.diagnostics.issues.some(i => i.includes('no tasks'))).toBe(true)
  })

  it('fails when a task has no substeps', () => {
    const task = { ...validPlan.phases[0].tasks[0], substeps: [] }
    const plan: DetailedPlan = { ...validPlan, phases: [{ ...validPlan.phases[0], tasks: [task] }] }
    const result = validatePlanOutput(plan)
    expect(result.passed).toBe(false)
    expect(result.diagnostics.issues.some(i => i.includes('no substeps'))).toBe(true)
  })

  it('fails when a task has neither files nor substep targets', () => {
    const task = { ...validPlan.phases[0].tasks[0], files: [], substeps: [{ id: 's1', action: 'run_test' as const }] }
    const plan: DetailedPlan = { ...validPlan, phases: [{ ...validPlan.phases[0], tasks: [task] }] }
    const result = validatePlanOutput(plan)
    expect(result.passed).toBe(false)
    expect(result.diagnostics.issues.some(i => i.includes('no actionable target'))).toBe(true)
  })

  it('fails when a task has no validation', () => {
    const task = { ...validPlan.phases[0].tasks[0], validation: [] }
    const plan: DetailedPlan = { ...validPlan, phases: [{ ...validPlan.phases[0], tasks: [task] }] }
    const result = validatePlanOutput(plan)
    expect(result.passed).toBe(false)
    expect(result.diagnostics.issues.some(i => i.includes('no validation'))).toBe(true)
  })

  it('fails when a task has no expected_result', () => {
    const task = { ...validPlan.phases[0].tasks[0], expected_result: '' }
    const plan: DetailedPlan = { ...validPlan, phases: [{ ...validPlan.phases[0], tasks: [task] }] }
    const result = validatePlanOutput(plan)
    expect(result.passed).toBe(false)
    expect(result.diagnostics.issues.some(i => i.includes('no expected_result'))).toBe(true)
  })

  it('fails when depends_on references an unknown task id', () => {
    const task = { ...validPlan.phases[0].tasks[0], depends_on: ['task_999'] }
    const plan: DetailedPlan = { ...validPlan, phases: [{ ...validPlan.phases[0], tasks: [task] }] }
    const result = validatePlanOutput(plan)
    expect(result.passed).toBe(false)
    expect(result.diagnostics.issues.some(i => i.includes('task_999'))).toBe(true)
  })

  it('detects circular dependencies', () => {
    const taskA = { ...validPlan.phases[0].tasks[0], id: 'task_a', depends_on: ['task_b'] }
    const taskB: typeof taskA = { ...taskA, id: 'task_b', depends_on: ['task_a'] }
    const plan: DetailedPlan = { ...validPlan, phases: [{ ...validPlan.phases[0], tasks: [taskA, taskB] }] }
    const result = validatePlanOutput(plan)
    expect(result.passed).toBe(false)
    expect(result.diagnostics.issues.some(i => i.includes('circular'))).toBe(true)
  })

  it('accepts a task with no files when a substep has a command', () => {
    const task = {
      ...validPlan.phases[0].tasks[0],
      files: [],
      substeps: [{ id: 's1', action: 'run_command' as const, command: 'npm test' }],
    }
    const plan: DetailedPlan = { ...validPlan, phases: [{ ...validPlan.phases[0], tasks: [task] }] }
    const result = validatePlanOutput(plan)
    expect(result.passed).toBe(true)
  })

  it('caps diagnostics issues at 10', () => {
    const badTask = (i: number) => ({
      id: `task_${i}`,
      title: `task ${i}`,
      type: 'backend' as const,
      files: [`file_${i}.ts`],
      depends_on: [],
      substeps: [],
      validation: [{ type: 'file_exists' as const, target: `file_${i}.ts` }],
      expected_result: 'done',
    })
    const plan: DetailedPlan = {
      ...validPlan,
      phases: [{ id: 'phase_1', title: 'p', depends_on: [], tasks: Array.from({ length: 15 }, (_, i) => badTask(i)) }],
    }
    const result = validatePlanOutput(plan)
    expect(result.passed).toBe(false)
    expect(result.diagnostics.issues.length).toBeLessThanOrEqual(10)
    expect(result.diagnostics.truncated).toBe(true)
  })
})
