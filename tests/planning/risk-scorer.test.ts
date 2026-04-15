import { describe, it, expect } from 'vitest'
import { scoreFromPlan } from '@/lib/planning/risk-scorer'
import type { DetailedPlan } from '@/lib/planning/types'

function makePlan(overrides: Partial<{
  taskCount: number
  substepsPerTask: number
  taskType: 'backend' | 'database'
  hasMigrationCommand: boolean
}>): DetailedPlan {
  const { taskCount = 3, substepsPerTask = 2, taskType = 'backend', hasMigrationCommand = false } = overrides
  const tasks = Array.from({ length: taskCount }, (_, i) => ({
    id: `task_${i}`,
    title: `Task ${i}`,
    type: taskType,
    files: [`lib/file_${i}.ts`],
    depends_on: [],
    substeps: Array.from({ length: substepsPerTask }, (_, j) => ({
      id: `step_${i}_${j}`,
      action: 'write_file' as const,
      ...(hasMigrationCommand && j === 0 ? { command: 'supabase db push' } : { target: `lib/file_${i}.ts` }),
    })),
    validation: [{ type: 'file_exists' as const, target: `lib/file_${i}.ts` }],
    expected_result: 'done',
  }))
  return {
    schema_version: 1,
    planner_version: 1,
    goal: 'Test',
    phases: [{ id: 'phase_1', title: 'P', depends_on: [], tasks }],
  }
}

describe('scoreFromPlan', () => {
  it('returns low risk for a small, simple plan', () => {
    const result = scoreFromPlan(makePlan({ taskCount: 3, substepsPerTask: 2 }), 0)
    expect(result.riskLevel).toBe('low')
  })

  it('returns higher risk for a large plan', () => {
    const result = scoreFromPlan(makePlan({ taskCount: 15, substepsPerTask: 3 }), 0)
    expect(['medium', 'high']).toContain(result.riskLevel)
  })

  it('boosts risk when plan has migration commands', () => {
    const withMigration = scoreFromPlan(makePlan({ hasMigrationCommand: true }), 0)
    const withoutMigration = scoreFromPlan(makePlan({ hasMigrationCommand: false }), 0)
    expect(withMigration.score).toBeGreaterThan(withoutMigration.score)
  })

  it('boosts risk for database task type', () => {
    const db = scoreFromPlan(makePlan({ taskCount: 3, taskType: 'database' }), 0)
    const be = scoreFromPlan(makePlan({ taskCount: 3, taskType: 'backend' }), 0)
    expect(db.score).toBeGreaterThan(be.score)
  })

  it('boosts risk when drift ratio is high', () => {
    const lowDrift = scoreFromPlan(makePlan({ taskCount: 3 }), 1)
    const highDrift = scoreFromPlan(makePlan({ taskCount: 3 }), 10)
    expect(highDrift.score).toBeGreaterThan(lowDrift.score)
  })

  it('includes plan signals in result', () => {
    const result = scoreFromPlan(makePlan({ taskCount: 4, substepsPerTask: 3 }), 2.5)
    expect(result.signals.taskCount).toBe(4)
    expect(result.signals.substepCount).toBe(12)
    expect(result.signals.driftRatio).toBe(2.5)
  })

  it('identifies the primary risk signal', () => {
    const result = scoreFromPlan(makePlan({ taskCount: 3 }), 15)
    expect(result.primarySignal).toBe('high_drift')
  })
})
