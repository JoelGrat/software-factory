// tests/lib/execution/execution-tracer.test.ts
import { describe, it, expect } from 'vitest'
import { hashInput, hashOutput, recordTrace } from '@/lib/execution/execution-tracer'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { SymbolContext, FilePatch } from '@/lib/execution/types'

const CTX: SymbolContext = {
  symbolName: 'fn', filePath: 'src/a.ts', code: 'function fn() {}',
  locator: { primary: 'x', fallbacks: { kind: 0, approximatePosition: { line: 1, toleranceLines: 5 }, structureSignature: 'y' } },
  callers: [], callees: [], relatedTypes: [], complexity: 1,
}

describe('hashInput', () => {
  it('returns the same hash for the same inputs', () => {
    expect(hashInput(CTX, 'do task A')).toBe(hashInput(CTX, 'do task A'))
  })

  it('returns different hashes for different inputs', () => {
    expect(hashInput(CTX, 'do task A')).not.toBe(hashInput(CTX, 'do task B'))
  })
})

describe('hashOutput', () => {
  it('returns same hash for same newContent', () => {
    const patch = { newContent: 'function fn() { return 1 }' } as FilePatch
    expect(hashOutput(patch)).toBe(hashOutput(patch))
  })
})

describe('recordTrace', () => {
  it('inserts a row into execution_trace', async () => {
    const inserts: unknown[] = []
    const db = {
      from: () => ({
        insert: (row: unknown) => {
          inserts.push(row)
          return Promise.resolve({ error: null })
        },
      }),
    } as unknown as SupabaseClient

    await recordTrace(db, {
      changeId: 'cr1', iteration: 1, taskId: 't1',
      contextMode: 'symbol', inputHash: 'abc', outputHash: 'def',
      strategyUsed: 'initial', failureType: null, confidence: 85,
    })
    expect(inserts).toHaveLength(1)
  })
})
