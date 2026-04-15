import { describe, it, expect } from 'vitest'
import { projectToTasks } from '@/lib/planning/human-task-view'
import type { DetailedPlan } from '@/lib/planning/types'

const plan: DetailedPlan = {
  schema_version: 1,
  planner_version: 1,
  goal: 'Test',
  phases: [
    {
      id: 'phase_1',
      title: 'Phase One',
      depends_on: [],
      tasks: [
        {
          id: 'task_1', title: 'First task', description: 'Do the first thing',
          type: 'backend', files: ['lib/foo.ts'], depends_on: [],
          substeps: [{ id: 's1', action: 'write_file', target: 'lib/foo.ts' }],
          validation: [{ type: 'file_exists', target: 'lib/foo.ts' }],
          expected_result: 'File created',
        },
        {
          id: 'task_2', title: 'Second task', description: undefined,
          type: 'testing', files: ['tests/foo.test.ts'], depends_on: ['task_1'],
          substeps: [{ id: 's1', action: 'run_test' }],
          validation: [{ type: 'test_pass' }],
          expected_result: 'Tests pass',
        },
      ],
    },
    {
      id: 'phase_2',
      title: 'Phase Two',
      depends_on: ['phase_1'],
      tasks: [
        {
          id: 'task_3', title: 'Third task', description: 'Phase 2 work',
          type: 'api', files: ['app/api/foo/route.ts'], depends_on: [],
          substeps: [{ id: 's1', action: 'write_file', target: 'app/api/foo/route.ts' }],
          validation: [{ type: 'file_exists', target: 'app/api/foo/route.ts' }],
          expected_result: 'Route exists',
        },
      ],
    },
  ],
}

describe('projectToTasks', () => {
  it('returns one row per task across all phases', () => {
    const tasks = projectToTasks(plan)
    expect(tasks).toHaveLength(3)
  })

  it('assigns monotonically increasing order indices', () => {
    const tasks = projectToTasks(plan)
    expect(tasks[0].orderIndex).toBe(0)
    expect(tasks[1].orderIndex).toBe(1)
    expect(tasks[2].orderIndex).toBe(2)
  })

  it('preserves planTaskId and phaseId', () => {
    const tasks = projectToTasks(plan)
    expect(tasks[0].planTaskId).toBe('task_1')
    expect(tasks[0].phaseId).toBe('phase_1')
    expect(tasks[2].planTaskId).toBe('task_3')
    expect(tasks[2].phaseId).toBe('phase_2')
  })

  it('preserves title and description', () => {
    const tasks = projectToTasks(plan)
    expect(tasks[0].title).toBe('First task')
    expect(tasks[0].description).toBe('Do the first thing')
    expect(tasks[1].description).toBeUndefined()
  })

  it('sets all statuses to pending', () => {
    const tasks = projectToTasks(plan)
    expect(tasks.every(t => t.status === 'pending')).toBe(true)
  })

  it('returns empty array for plan with no tasks', () => {
    const emptyPlan: DetailedPlan = { ...plan, phases: [{ id: 'p1', title: 'P', depends_on: [], tasks: [] }] }
    expect(projectToTasks(emptyPlan)).toHaveLength(0)
  })
})
