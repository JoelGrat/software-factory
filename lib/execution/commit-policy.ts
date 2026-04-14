import type { CommitOutcome } from './execution-types-v2'

interface CommitDecisionInput {
  allChecksPassed: boolean
  hasDiff: boolean
  cancelled: boolean
  dirtyFiles: string[]          // from `git status --porcelain`
  runFilesChanged: string[]     // files this run touched
  finalFailureType: string | null
}

export function determineCommitOutcome(input: CommitDecisionInput): CommitOutcome {
  if (input.cancelled) {
    return { type: 'no_commit', reason: 'run was cancelled' }
  }

  if (!input.hasDiff) {
    return { type: 'no_commit', reason: 'no diff produced' }
  }

  // Check for unrelated dirty files.
  // git status --porcelain collapses new files inside a new directory to just the
  // directory path (e.g. "src/__tests__/" instead of "src/__tests__/smoke.test.ts").
  // Treat a trailing-slash entry as accounted-for if any tracked file starts with it.
  const unexpected = input.dirtyFiles.filter(f => {
    if (input.runFilesChanged.includes(f)) return false
    if (f.endsWith('/') && input.runFilesChanged.some(rf => rf.startsWith(f))) return false
    return true
  })
  if (unexpected.length > 0) {
    return { type: 'no_commit', reason: 'working tree contains unexpected changes' }
  }

  if (input.allChecksPassed) {
    return { type: 'green' }
  }

  return { type: 'wip', reason: input.finalFailureType ?? 'checks failed' }
}
