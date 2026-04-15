import type { IterationRecord, StuckResult } from './execution-types-v2'

interface PerIterationBudget {
  maxInlineRepairs: number
  maxRepairPhaseAttempts: number
}

export function detectStuck(
  history: IterationRecord[],
  current: IterationRecord,
  budget: PerIterationBudget,
): StuckResult {
  if (history.length === 0) return { stuck: false, reason: null }

  const prev = history[history.length - 1]!

  // 1. Error count increased — check this BEFORE the sig-overlap rule so regression
  //    takes priority over the weaker "some sigs overlap" signal.
  if (prev.errorCount > 0 && current.errorCount > prev.errorCount) {
    // If prev errors are still present alongside new ones, it's a pure regression.
    // If prev errors are gone but new ones appeared, partial progress exposed the next layer.
    const prevErrorsStillPresent = prev.diagnosticSigs.some(sig => current.diagnosticSigs.includes(sig))
    return {
      stuck: true,
      reason: prevErrorsStillPresent ? 'validation_regressed' : 'new_errors_after_partial_fix',
    }
  }

  // 2. Same diagnostic signatures repeated — no change at all (error count not increasing)
  if (
    current.diagnosticSigs.length > 0 &&
    current.diagnosticSigs.some(sig => prev.diagnosticSigs.includes(sig))
  ) {
    return { stuck: true, reason: 'same_errors_repeated' }
  }

  // 2b. Same non-zero error count for two consecutive iterations — repairs made no progress.
  // Fingerprint check (rule 1) catches identical sigs; this catches cases where the error
  // message shifts slightly but the failure count is unchanged.
  if (prev.errorCount > 0 && current.errorCount === prev.errorCount && history.length >= 2) {
    const prevPrev = history[history.length - 2]!
    if (prevPrev.errorCount === prev.errorCount) {
      return { stuck: true, reason: 'same_errors_repeated' }
    }
  }

  // 3. Same file patched 3+ times across history + current
  const allRepairedFiles = [...history.flatMap(r => r.repairedFiles), ...current.repairedFiles]
  const fileCounts = new Map<string, number>()
  for (const f of allRepairedFiles) fileCounts.set(f, (fileCounts.get(f) ?? 0) + 1)
  for (const [, count] of fileCounts) {
    if (count >= 3) return { stuck: true, reason: 'same_file_repeated' }
  }

  // 4. Oscillating diagnostic pattern (A→B→A across last 3 iterations)
  if (history.length >= 2) {
    const prevPrev = history[history.length - 2]!
    if (
      current.diagnosticSigs.length > 0 &&
      prevPrev.diagnosticSigs.length > 0 &&
      current.diagnosticSigs.some(sig => prevPrev.diagnosticSigs.includes(sig)) &&
      prev.diagnosticSigs.some(sig => !current.diagnosticSigs.includes(sig))
    ) {
      return { stuck: true, reason: 'oscillating_errors' }
    }
  }

  return { stuck: false, reason: null }
}
