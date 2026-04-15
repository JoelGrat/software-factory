import { describe, it, expect } from 'vitest'
import { detectStuck } from '@/lib/execution/stuck-detector'
import type { IterationRecord } from '@/lib/execution/execution-types-v2'

function rec(overrides: Partial<IterationRecord> = {}): IterationRecord {
  return { iteration: 1, diagnosticSigs: [], errorCount: 0, resolvedCount: 0, newCount: 0, repairedFiles: [], ...overrides }
}

const budget = { maxInlineRepairs: 3, maxRepairPhaseAttempts: 2 }

describe('detectStuck', () => {
  it('returns not stuck with no history', () => {
    expect(detectStuck([], rec(), budget)).toEqual({ stuck: false, reason: null })
  })

  it('detects same_errors_repeated when identical sigs recur', () => {
    const prev = rec({ diagnosticSigs: ['abc123'] })
    const curr = rec({ diagnosticSigs: ['abc123'] })
    expect(detectStuck([prev], curr, budget)).toEqual({ stuck: true, reason: 'same_errors_repeated' })
  })

  it('detects validation_regressed when error count rises and prev errors still present', () => {
    const prev = rec({ diagnosticSigs: ['err-a', 'err-b'], errorCount: 2 })
    const curr = rec({ diagnosticSigs: ['err-a', 'err-b', 'err-c', 'err-d', 'err-e'], errorCount: 5 })
    expect(detectStuck([prev], curr, budget)).toEqual({ stuck: true, reason: 'validation_regressed' })
  })

  it('detects new_errors_after_partial_fix when old errors gone but new ones appeared', () => {
    const prev = rec({ diagnosticSigs: ['supabase-import-err'], errorCount: 1 })
    const curr = rec({ diagnosticSigs: ['mock-type-err-1', 'mock-type-err-2', 'mock-type-err-3'], errorCount: 3 })
    expect(detectStuck([prev], curr, budget)).toEqual({ stuck: true, reason: 'new_errors_after_partial_fix' })
  })

  it('detects same_file_repeated after 3 patches', () => {
    const history = [
      rec({ repairedFiles: ['a.ts'] }),
      rec({ repairedFiles: ['a.ts'] }),
    ]
    const curr = rec({ repairedFiles: ['a.ts'] })
    expect(detectStuck(history, curr, budget)).toEqual({ stuck: true, reason: 'same_file_repeated' })
  })

  it('detects oscillating_errors A→B→A pattern', () => {
    const history = [
      rec({ diagnosticSigs: ['aaa'] }),
      rec({ diagnosticSigs: ['bbb'] }),
    ]
    const curr = rec({ diagnosticSigs: ['aaa'] })
    expect(detectStuck(history, curr, budget)).toEqual({ stuck: true, reason: 'oscillating_errors' })
  })

  it('returns not stuck for healthy iteration with decreasing errors', () => {
    const history = [rec({ diagnosticSigs: ['aaa'], errorCount: 3 })]
    const curr = rec({ diagnosticSigs: ['bbb'], errorCount: 1 })
    expect(detectStuck(history, curr, budget)).toEqual({ stuck: false, reason: null })
  })
})
