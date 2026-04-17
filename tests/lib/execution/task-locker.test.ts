import { describe, it, expect } from 'vitest'
import { acquireTaskLock, crashRecoveryCleanup } from '@/lib/execution/task-locker'

describe('acquireTaskLock', () => {
  it('returns true when exactly one row is updated (lock acquired)', async () => {
    const db = {
      from: () => ({
        update: () => ({
          eq: () => ({
            eq: () => ({
              select: () => ({ data: [{ id: 'task-1' }], error: null }),
            }),
          }),
        }),
      }),
    } as unknown as import('@supabase/supabase-js').SupabaseClient
    expect(await acquireTaskLock(db, 'task-1', 'run-1')).toBe(true)
  })

  it('returns false when no rows updated (already locked by other run)', async () => {
    const db = {
      from: () => ({
        update: () => ({
          eq: () => ({
            eq: () => ({
              select: () => ({ data: [], error: null }),
            }),
          }),
        }),
      }),
    } as unknown as import('@supabase/supabase-js').SupabaseClient
    expect(await acquireTaskLock(db, 'task-1', 'run-2')).toBe(false)
  })
})

describe('crashRecoveryCleanup', () => {
  it('does not throw when no zombie tasks exist', async () => {
    const db = {
      from: () => ({
        update: () => ({
          eq: () => ({
            lt: () => ({ error: null }),
          }),
        }),
      }),
    } as unknown as import('@supabase/supabase-js').SupabaseClient
    await expect(crashRecoveryCleanup(db)).resolves.not.toThrow()
  })
})
