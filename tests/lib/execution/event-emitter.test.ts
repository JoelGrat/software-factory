import { describe, it, expect, vi } from 'vitest'
import { insertEvent, validatePayload, nextSeq, clearSeq } from '@/lib/execution/event-emitter'
import type { SupabaseClient } from '@supabase/supabase-js'

function makeDb(insertFn: (row: unknown) => unknown) {
  return {
    from: () => ({ insert: insertFn }),
  } as unknown as SupabaseClient
}

describe('validatePayload', () => {
  it('passes a valid phase.static_validation.failed payload', () => {
    expect(() => validatePayload('phase.static_validation.failed', {
      diagnostics: [{ file: 'a.ts', line: 1, message: 'err', code: 'TS2322' }],
      totalCount: 1,
      truncated: false,
      durationMs: 100,
    })).not.toThrow()
  })

  it('throws on missing required field', () => {
    expect(() => validatePayload('phase.static_validation.failed', {
      diagnostics: [],
      totalCount: 0,
      // missing truncated and durationMs
    })).toThrow()
  })

  it('passes unknown event types with empty payload', () => {
    expect(() => validatePayload('execution.started', {})).not.toThrow()
  })
})

describe('insertEvent', () => {
  it('inserts a validated event row', async () => {
    const rows: unknown[] = []
    const db = makeDb((row) => { rows.push(row); return { error: null } })

    await insertEvent(db, {
      runId: 'run1',
      changeId: 'cr1',
      seq: 1,
      iteration: 0,
      eventType: 'execution.started',
      payload: {},
    })

    expect(rows).toHaveLength(1)
    expect((rows[0] as any).event_type).toBe('execution.started')
    expect((rows[0] as any).seq).toBe(1)
  })

  it('throws EventPayloadValidationError on invalid payload', async () => {
    const db = makeDb(() => ({ error: null }))
    await expect(insertEvent(db, {
      runId: 'run1',
      changeId: 'cr1',
      seq: 2,
      iteration: 0,
      eventType: 'phase.static_validation.failed',
      payload: { diagnostics: 'not-an-array' },
    })).rejects.toThrow('EventPayloadValidationError')
  })
})

describe('nextSeq / clearSeq', () => {
  it('increments seq per runId', () => {
    clearSeq('test-run-seq')
    expect(nextSeq('test-run-seq')).toBe(1)
    expect(nextSeq('test-run-seq')).toBe(2)
    expect(nextSeq('test-run-seq')).toBe(3)
  })

  it('counters are independent per runId', () => {
    clearSeq('run-a')
    clearSeq('run-b')
    expect(nextSeq('run-a')).toBe(1)
    expect(nextSeq('run-b')).toBe(1)
    expect(nextSeq('run-a')).toBe(2)
  })

  it('clearSeq resets counter to 0', () => {
    clearSeq('test-clear')
    nextSeq('test-clear')
    nextSeq('test-clear')
    clearSeq('test-clear')
    expect(nextSeq('test-clear')).toBe(1)
  })
})

describe('insertEvent DB error handling', () => {
  it('throws when DB insert returns an error', async () => {
    const db = {
      from: () => ({
        insert: () => ({ error: { message: 'unique constraint violation' } }),
      }),
    } as unknown as SupabaseClient

    await expect(insertEvent(db, {
      runId: 'run1',
      changeId: 'cr1',
      seq: 99,
      iteration: 0,
      eventType: 'execution.started',
      payload: {},
    })).rejects.toThrow('insertEvent failed')
  })
})
