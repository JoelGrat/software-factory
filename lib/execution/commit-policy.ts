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

  // Check for unrelated dirty files
  const unexpected = input.dirtyFiles.filter(f => !input.runFilesChanged.includes(f))
  if (unexpected.length > 0) {
    return { type: 'no_commit', reason: 'working tree contains unexpected changes' }
  }

  if (input.allChecksPassed) {
    return { type: 'green' }
  }

  return { type: 'wip', reason: input.finalFailureType ?? 'checks failed' }
}
