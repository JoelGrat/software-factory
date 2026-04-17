import { describe, it, expect } from 'vitest'
import { computeTaskRunSummary } from '@/lib/execution/execution-summary'

interface Task { id: string; status: string }

describe('computeTaskRunSummary', () => {
  it('finalStatus=success when all tasks are done', () => {
    const tasks: Task[] = [
      { id: '1', status: 'done' },
      { id: '2', status: 'done' },
    ]
    const result = computeTaskRunSummary(tasks, 5000)
    expect(result.finalStatus).toBe('success')
    expect(result.completedTasks).toEqual(['1', '2'])
    expect(result.failedTasks).toEqual([])
    expect(result.totalTasks).toBe(2)
    expect(result.durationMs).toBe(5000)
  })

  it('finalStatus=partial when some done and some failed', () => {
    const tasks: Task[] = [
      { id: '1', status: 'done' },
      { id: '2', status: 'failed' },
    ]
    const result = computeTaskRunSummary(tasks, 3000)
    expect(result.finalStatus).toBe('partial')
    expect(result.failedTasks).toEqual(['2'])
  })

  it('finalStatus=failed when no tasks are done', () => {
    const tasks: Task[] = [
      { id: '1', status: 'failed' },
      { id: '2', status: 'blocked' },
    ]
    const result = computeTaskRunSummary(tasks, 1000)
    expect(result.finalStatus).toBe('failed')
    expect(result.blockedTasks).toEqual(['2'])
  })

  it('finalStatus=partial when some done and some blocked', () => {
    const tasks: Task[] = [
      { id: '1', status: 'done' },
      { id: '2', status: 'blocked' },
    ]
    expect(computeTaskRunSummary(tasks, 1000).finalStatus).toBe('partial')
  })
})
