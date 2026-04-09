// tests/lib/dashboard/event-counter.test.ts
import { describe, it, expect, vi } from 'vitest'
import { nextVersion } from '@/lib/dashboard/event-counter'

const mockRpc = vi.fn()
const mockDb = { rpc: mockRpc } as unknown as import('@supabase/supabase-js').SupabaseClient

describe('nextVersion', () => {
  it('calls increment_project_event_version and returns the version', async () => {
    mockRpc.mockResolvedValueOnce({ data: 42, error: null })
    const v = await nextVersion(mockDb, 'proj-1')
    expect(v).toBe(42)
    expect(mockRpc).toHaveBeenCalledWith('increment_project_event_version', { p_project_id: 'proj-1' })
  })

  it('throws if rpc returns an error', async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: new Error('db error') })
    await expect(nextVersion(mockDb, 'proj-1')).rejects.toThrow('db error')
  })
})
