// tests/lib/dashboard/snapshot-writer.test.ts
import { describe, it, expect, vi } from 'vitest'
import { writeStub, enrichSnapshot, markEnrichmentFailed } from '@/lib/dashboard/snapshot-writer'
import type { AnalysisResultSnapshotData } from '@/lib/dashboard/event-types'

const mockInsert = vi.fn().mockReturnValue({ error: null })
const mockUpdate = vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ error: null }) })
const mockFrom = vi.fn((_table: string) => ({
  insert: mockInsert,
  update: mockUpdate,
}))
const mockDb = { from: mockFrom } as unknown as import('@supabase/supabase-js').SupabaseClient

describe('writeStub', () => {
  it('inserts a minimal stub row', async () => {
    mockInsert.mockReturnValueOnce({ error: null })
    await writeStub(mockDb, 'c1', 7, 'success', 'completed')
    expect(mockFrom).toHaveBeenCalledWith('analysis_result_snapshot')
    const inserted = mockInsert.mock.calls[0][0]
    expect(inserted.change_id).toBe('c1')
    expect(inserted.version).toBe(7)
    expect(inserted.execution_outcome).toBe('success')
    expect(inserted.minimal).toBe(true)
    expect(inserted.snapshot_status).toBe('pending_enrichment')
  })

  it('throws if insert fails', async () => {
    mockInsert.mockReturnValueOnce({ error: new Error('db failure') })
    await expect(writeStub(mockDb, 'c1', 7, 'success', 'completed')).rejects.toThrow('db failure')
  })
})

describe('enrichSnapshot', () => {
  it('updates snapshot_status to ok and minimal to false', async () => {
    const eqMock = vi.fn().mockReturnValue({ error: null })
    mockUpdate.mockReturnValueOnce({ eq: eqMock })
    // Note: use camelCase field names from AnalysisResultSnapshotData
    const data: Partial<AnalysisResultSnapshotData> = {
      jaccardAccuracy: 0.82,
      missRate: 0.18,
    }
    await enrichSnapshot(mockDb, 'c1', data)
    expect(mockUpdate).toHaveBeenCalled()
    const updated = mockUpdate.mock.calls[0][0]
    expect(updated.snapshot_status).toBe('ok')
    expect(updated.minimal).toBe(false)
    expect(eqMock).toHaveBeenCalledWith('change_id', 'c1')
  })
})

describe('markEnrichmentFailed', () => {
  it('updates snapshot_status to enrichment_failed', async () => {
    const eqMock = vi.fn().mockReturnValue({ error: null })
    mockUpdate.mockReturnValueOnce({ eq: eqMock })
    await markEnrichmentFailed(mockDb, 'c1')
    const updated = mockUpdate.mock.calls[mockUpdate.mock.calls.length - 1][0]
    expect(updated.snapshot_status).toBe('enrichment_failed')
    expect(eqMock).toHaveBeenCalledWith('change_id', 'c1')
  })

  it('logs error if update fails (does not throw)', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const eqMock = vi.fn().mockReturnValue({ error: new Error('db failure') })
    mockUpdate.mockReturnValueOnce({ eq: eqMock })
    await expect(markEnrichmentFailed(mockDb, 'c1')).resolves.toBeUndefined()
    expect(consoleSpy).toHaveBeenCalled()
    consoleSpy.mockRestore()
  })
})
