import { describe, it, expect } from 'vitest'
import { detectStuck } from '@/lib/execution/stuck-detector'
import type { IterationRecord } from '@/lib/execution/execution-types-v2'

function rec(overrides: Partial<IterationRecord> = {}): IterationRecord {
  return { iteration: 1, diagnosticSigs: [], errorCount: 0, repairedFiles: [], ...overrides }
}

describe('detectStuck', () => {
  it('returns not stuck with no history', () => {
    expect(detectStuck([], rec(), { maxInlineRepairs: 3, maxRepairPhaseAttempts: 2 })).toEqual({ stuck: false, reason: null })
  })

  it('detects repeated_diagnostic', () => {
    const prev = rec({ diagnosticSigs: ['abc123'] })
    const curr = rec({ diagnosticSigs: ['abc123'] })
    const result = detectStuck([prev], curr, { maxInlineRepairs: 3, maxRepairPhaseAttempts: 2 })
    expect(result).toEqual({ stuck: true, reason: 'repeated_diagnostic' })
  })

  it('detects error_count_increased', () => {
    const prev = rec({ errorCount: 2 })
    const curr = rec({ errorCount: 5 })
    expect(detectStuck([prev], curr, { maxInlineRepairs: 3, maxRepairPhaseAttempts: 2 })).toEqual({ stuck: true, reason: 'error_count_increased' })
  })

  it('detects same_file_repeated after 3 patches', () => {
    const history = [
      rec({ repairedFiles: ['a.ts'] }),
      rec({ repairedFiles: ['a.ts'] }),
    ]
    const curr = rec({ repairedFiles: ['a.ts'] })
    expect(detectStuck(history, curr, { maxInlineRepairs: 3, maxRepairPhaseAttempts: 2 })).toEqual({ stuck: true, reason: 'same_file_repeated' })
  })

  it('detects alternating_diagnostic A→B→A', () => {
    const history = [
      rec({ diagnosticSigs: ['aaa'] }),
      rec({ diagnosticSigs: ['bbb'] }),
    ]
    const curr = rec({ diagnosticSigs: ['aaa'] })
    expect(detectStuck(history, curr, { maxInlineRepairs: 3, maxRepairPhaseAttempts: 2 })).toEqual({ stuck: true, reason: 'alternating_diagnostic' })
  })

  it('returns not stuck for healthy iterations', () => {
    const history = [rec({ diagnosticSigs: ['aaa'], errorCount: 3 })]
    const curr = rec({ diagnosticSigs: ['bbb'], errorCount: 1 })
    expect(detectStuck(history, curr, { maxInlineRepairs: 3, maxRepairPhaseAttempts: 2 })).toEqual({ stuck: false, reason: null })
  })
})
