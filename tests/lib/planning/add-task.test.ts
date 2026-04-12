// tests/lib/planning/add-task.test.ts
import { describe, it, expect, vi } from 'vitest'
import { insertPlanTask } from '@/lib/planning/add-task'

function makeDb(insertResult: { data?: any; error?: any }) {
  const selectMock = vi.fn().mockReturnValue({
    select: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: insertResult.data?.[0] ?? null, error: insertResult.error ?? null }),
  })
  const insertMock = vi.fn().mockReturnValue({
    select: vi.fn().mockReturnValue({
      single: vi.fn().mockResolvedValue(insertResult),
    }),
  })
  const fromMock = vi.fn(() => ({ insert: insertMock }))
  return { db: { from: fromMock } as any, insertMock, fromMock }
}

describe('insertPlanTask', () => {
  it('inserts with order_index one past the maximum existing', async () => {
    const task = { id: 'new-task', plan_id: 'plan-1', description: 'Write test: invalid ID handling', order_index: 3, status: 'pending', component_id: null }
    const { db, insertMock, fromMock } = makeDb({ data: [task], error: null })

    await insertPlanTask(db, 'plan-1', 'Write test: invalid ID handling', [
      { order_index: 0 }, { order_index: 2 }, { order_index: 1 },
    ])

    expect(fromMock).toHaveBeenCalledWith('change_plan_tasks')
    const row = insertMock.mock.calls[0][0]
    expect(row.plan_id).toBe('plan-1')
    expect(row.description).toBe('Write test: invalid ID handling')
    expect(row.order_index).toBe(3)
    expect(row.status).toBe('pending')
    expect(row.component_id).toBeNull()
  })

  it('uses order_index 0 when plan has no existing tasks', async () => {
    const task = { id: 'new-task', plan_id: 'plan-1', description: 'Write test: direct URL access', order_index: 0, status: 'pending', component_id: null }
    const { db, insertMock } = makeDb({ data: [task], error: null })

    await insertPlanTask(db, 'plan-1', 'Write test: direct URL access', [])

    const row = insertMock.mock.calls[0][0]
    expect(row.order_index).toBe(0)
  })

  it('throws when the insert fails', async () => {
    const { db } = makeDb({ error: new Error('db write failed') })

    await expect(
      insertPlanTask(db, 'plan-1', 'Write test', [])
    ).rejects.toThrow('db write failed')
  })
})
