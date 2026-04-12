import { describe, it, expect } from 'vitest'
import { determineCommitOutcome } from '@/lib/execution/commit-policy'

describe('determineCommitOutcome', () => {
  it('returns green when all checks passed and no dirty tree', () => {
    const result = determineCommitOutcome({
      allChecksPassed: true,
      hasDiff: true,
      cancelled: false,
      dirtyFiles: [],
      runFilesChanged: ['app/page.tsx'],
      finalFailureType: null,
    })
    expect(result).toEqual({ type: 'green' })
  })

  it('returns no_commit when there is no diff', () => {
    const result = determineCommitOutcome({
      allChecksPassed: false,
      hasDiff: false,
      cancelled: false,
      dirtyFiles: [],
      runFilesChanged: [],
      finalFailureType: 'tsc',
    })
    expect(result).toEqual({ type: 'no_commit', reason: 'no diff produced' })
  })

  it('returns no_commit when cancelled', () => {
    const result = determineCommitOutcome({
      allChecksPassed: false,
      hasDiff: true,
      cancelled: true,
      dirtyFiles: [],
      runFilesChanged: ['app/page.tsx'],
      finalFailureType: null,
    })
    expect(result).toEqual({ type: 'no_commit', reason: 'run was cancelled' })
  })

  it('returns wip when checks failed but diff exists and no dirty contamination', () => {
    const result = determineCommitOutcome({
      allChecksPassed: false,
      hasDiff: true,
      cancelled: false,
      dirtyFiles: [],
      runFilesChanged: ['app/page.tsx'],
      finalFailureType: 'tsc: 2 errors',
    })
    expect(result).toEqual({ type: 'wip', reason: 'tsc: 2 errors' })
  })

  it('returns no_commit when dirty tree contains unrelated files', () => {
    const result = determineCommitOutcome({
      allChecksPassed: false,
      hasDiff: true,
      cancelled: false,
      dirtyFiles: ['README.md'],    // not in runFilesChanged
      runFilesChanged: ['app/page.tsx'],
      finalFailureType: 'tsc',
    })
    expect(result).toEqual({ type: 'no_commit', reason: 'working tree contains unexpected changes' })
  })
})
