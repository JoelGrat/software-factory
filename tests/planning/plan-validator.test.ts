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

const validTask = {
  id: 'task_1',
  title: 'Write migration',
  type: 'database' as const,
  files: ['supabase/migrations/025_planning_refactor.sql'],
  depends_on: [],
  substeps: [{ id: 'step_1', action: 'write_file' as const, target: 'supabase/migrations/025_planning_refactor.sql' }],
  validation: [{ type: 'command' as const, command: 'supabase db push' }],
  expected_result: 'Migration applied',
  playbook: {
    implementation_notes: ['Run supabase db push after writing'],
    commands: ['supabase db push'],
    expected_outputs: ['Migration applied successfully'],
    code_snippets: [{
      file: 'supabase/migrations/025_planning_refactor.sql',
      language: 'sql',
      purpose: 'Create planning tables',
      content: 'create table foo (id uuid primary key);',
    }],
    temporary_failures_allowed: [],
    commit: 'feat: add planning refactor migration',
    rollback: ['supabase db reset'],
  },
}

const validPlan: DetailedPlan = {
  schema_version: 2,
  planner_version: 1,
  goal: 'Build new planner',
  branch_name: 'sf/abc123-build-new-planner',
  summary: {
    architecture: 'New pipeline with 6 stages using phases and substeps',
    tech_stack: ['Next.js', 'Supabase', 'TypeScript'],
    spec_ref: '',
  },
  file_map: { create: [], rewrite: [], delete: [] },
  phases: [{
    id: 'phase_1',
    title: 'Foundation',
    depends_on: [],
    tasks: [validTask],
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
    const task = { ...validTask, substeps: [] }
    const plan: DetailedPlan = { ...validPlan, phases: [{ ...validPlan.phases[0], tasks: [task] }] }
    const result = validatePlanOutput(plan)
    expect(result.passed).toBe(false)
    expect(result.diagnostics.issues.some(i => i.includes('no substeps'))).toBe(true)
  })

  it('fails when a task has neither files nor substep targets', () => {
    const task = { ...validTask, files: [], substeps: [{ id: 's1', action: 'run_test' as const }] }
    const plan: DetailedPlan = { ...validPlan, phases: [{ ...validPlan.phases[0], tasks: [task] }] }
    const result = validatePlanOutput(plan)
    expect(result.passed).toBe(false)
    expect(result.diagnostics.issues.some(i => i.includes('no actionable target'))).toBe(true)
  })

  it('fails when a task has no validation', () => {
    const task = { ...validTask, validation: [] }
    const plan: DetailedPlan = { ...validPlan, phases: [{ ...validPlan.phases[0], tasks: [task] }] }
    const result = validatePlanOutput(plan)
    expect(result.passed).toBe(false)
    expect(result.diagnostics.issues.some(i => i.includes('no validation'))).toBe(true)
  })

  it('fails when a task has no expected_result', () => {
    const task = { ...validTask, expected_result: '' }
    const plan: DetailedPlan = { ...validPlan, phases: [{ ...validPlan.phases[0], tasks: [task] }] }
    const result = validatePlanOutput(plan)
    expect(result.passed).toBe(false)
    expect(result.diagnostics.issues.some(i => i.includes('no expected_result'))).toBe(true)
  })

  it('fails when a task has no playbook', () => {
    const task = { ...validTask, playbook: undefined as any }
    const plan: DetailedPlan = { ...validPlan, phases: [{ ...validPlan.phases[0], tasks: [task] }] }
    const result = validatePlanOutput(plan)
    expect(result.passed).toBe(false)
    expect(result.diagnostics.issues.some(i => i.includes('no playbook'))).toBe(true)
  })

  it('fails when playbook.commit is empty', () => {
    const task = { ...validTask, playbook: { ...validTask.playbook, commit: '' } }
    const plan: DetailedPlan = { ...validPlan, phases: [{ ...validPlan.phases[0], tasks: [task] }] }
    const result = validatePlanOutput(plan)
    expect(result.passed).toBe(false)
    expect(result.diagnostics.issues.some(i => i.includes('playbook.commit is empty'))).toBe(true)
  })

  it('fails when a database task has no code_snippets', () => {
    const task = { ...validTask, playbook: { ...validTask.playbook, code_snippets: [] } }
    const plan: DetailedPlan = { ...validPlan, phases: [{ ...validPlan.phases[0], tasks: [task] }] }
    const result = validatePlanOutput(plan)
    expect(result.passed).toBe(false)
    expect(result.diagnostics.issues.some(i => i.includes('code_snippet'))).toBe(true)
  })

  it('does not require code_snippets for non-db/backend/refactor tasks', () => {
    const task = {
      ...validTask,
      type: 'testing' as const,
      playbook: { ...validTask.playbook, code_snippets: [] },
    }
    const plan: DetailedPlan = { ...validPlan, phases: [{ ...validPlan.phases[0], tasks: [task] }] }
    const result = validatePlanOutput(plan)
    expect(result.passed).toBe(true)
  })

  it('fails when depends_on references an unknown task id', () => {
    const task = { ...validTask, depends_on: ['task_999'] }
    const plan: DetailedPlan = { ...validPlan, phases: [{ ...validPlan.phases[0], tasks: [task] }] }
    const result = validatePlanOutput(plan)
    expect(result.passed).toBe(false)
    expect(result.diagnostics.issues.some(i => i.includes('task_999'))).toBe(true)
  })

  it('detects circular dependencies', () => {
    const taskA = { ...validTask, id: 'task_a', depends_on: ['task_b'] }
    const taskB = { ...validTask, id: 'task_b', depends_on: ['task_a'] }
    const plan: DetailedPlan = { ...validPlan, phases: [{ ...validPlan.phases[0], tasks: [taskA, taskB] }] }
    const result = validatePlanOutput(plan)
    expect(result.passed).toBe(false)
    expect(result.diagnostics.issues.some(i => i.includes('circular'))).toBe(true)
  })

  it('accepts a task with no files when a substep has a command', () => {
    const task = {
      ...validTask,
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
      playbook: { ...validTask.playbook, code_snippets: [validTask.playbook.code_snippets[0]] },
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
