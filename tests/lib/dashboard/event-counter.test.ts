// tests/lib/dashboard/event-counter.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextVersion } from '@/lib/dashboard/event-counter'
import { recordEvent, getEventsSince } from '@/lib/dashboard/event-history'

const mockRpc = vi.fn()
const mockDb = { rpc: mockRpc } as unknown as import('@supabase/supabase-js').SupabaseClient

beforeEach(() => { mockRpc.mockReset() })

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

// Mock helpers for event-history
function makeMockDb(overrides: Record<string, unknown> = {}) {
  const mockMaybeSingle = vi.fn().mockResolvedValue({ data: null, error: null })
  const mockSelect = vi.fn(() => ({
    eq: vi.fn(() => ({
      order: vi.fn(() => ({
        range: vi.fn(() => ({ maybeSingle: mockMaybeSingle })),
        limit: vi.fn(() => ({ maybeSingle: mockMaybeSingle })),
        gt: vi.fn(() => ({ order: vi.fn(() => ({ data: [], error: null })) })),
      })),
      gt: vi.fn(() => ({
        order: vi.fn(() => ({ data: [], error: null })),
      })),
      lt: vi.fn(() => ({ error: null })),
    })),
  }))
  const mockInsert = vi.fn(() => ({ error: null }))
  const mockDelete = vi.fn(() => ({
    eq: vi.fn(() => ({
      lt: vi.fn(() => ({ error: null })),
    })),
  }))
  const mockFrom = vi.fn(() => ({
    insert: mockInsert,
    select: mockSelect,
    delete: mockDelete,
  }))
  return {
    db: { from: mockFrom } as unknown as import('@supabase/supabase-js').SupabaseClient,
    mockFrom,
    mockInsert,
    mockSelect,
    mockMaybeSingle,
    ...overrides,
  }
}

const minimalEvent = {
  type: 'queued' as const,
  scope: 'analysis' as const,
  changeId: 'c1',
  projectId: 'proj-1',
  analysisVersion: 1,
  version: 5,
  payload: {},
}

describe('recordEvent', () => {
  it('inserts the event to event_history', async () => {
    const { db, mockInsert } = makeMockDb()
    await recordEvent(db, 'proj-1', minimalEvent)
    expect(mockInsert).toHaveBeenCalledWith({
      project_id: 'proj-1',
      version: 5,
      event_json: minimalEvent,
    })
  })

  it('returns early and logs if insert fails', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const mockFrom = vi.fn(() => ({
      insert: vi.fn(() => ({ error: new Error('insert failed') })),
      select: vi.fn(),
      delete: vi.fn(),
    }))
    const db = { from: mockFrom } as unknown as import('@supabase/supabase-js').SupabaseClient
    await recordEvent(db, 'proj-1', minimalEvent)
    expect(consoleSpy).toHaveBeenCalledWith(
      '[event-history] insert failed',
      expect.objectContaining({ projectId: 'proj-1', version: 5 })
    )
    consoleSpy.mockRestore()
  })
})

describe('getEventsSince', () => {
  it('returns null if sinceVersion is behind oldest stored event', async () => {
    const mockMaybeSingle = vi.fn()
    mockMaybeSingle.mockResolvedValueOnce({ data: { version: 10 }, error: null })
    const mockFrom = vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          order: vi.fn(() => ({
            limit: vi.fn(() => ({ maybeSingle: mockMaybeSingle })),
          })),
        })),
      })),
    }))
    const db = { from: mockFrom } as unknown as import('@supabase/supabase-js').SupabaseClient
    const result = await getEventsSince(db, 'proj-1', 5)
    expect(result).toBeNull()
  })

  it('returns empty array when no events since version', async () => {
    const mockMaybeSingle = vi.fn().mockResolvedValueOnce({ data: null, error: null })
    const mockFrom = vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          order: vi.fn(() => ({
            limit: vi.fn(() => ({ maybeSingle: mockMaybeSingle })),
            gt: vi.fn(() => ({ order: vi.fn(() => Promise.resolve({ data: [], error: null })) })),
          })),
          gt: vi.fn(() => ({
            order: vi.fn(() => Promise.resolve({ data: [], error: null })),
          })),
        })),
      })),
    }))
    const db = { from: mockFrom } as unknown as import('@supabase/supabase-js').SupabaseClient
    const result = await getEventsSince(db, 'proj-1', 0)
    expect(result).toEqual([])
  })
})
