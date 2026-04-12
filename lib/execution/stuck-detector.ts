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

  // 1. Same diagnostic signature as previous iteration
  if (
    current.diagnosticSigs.length > 0 &&
    current.diagnosticSigs.some(sig => prev.diagnosticSigs.includes(sig))
  ) {
    return { stuck: true, reason: 'repeated_diagnostic' }
  }

  // 2. Error count increased
  if (prev.errorCount > 0 && current.errorCount > prev.errorCount) {
    return { stuck: true, reason: 'error_count_increased' }
  }

  // 2b. Same non-zero error count for two consecutive iterations — repairs made no progress.
  // Fingerprint check (rule 1) handles identical sigs; this catches cases where the error
  // message shifts slightly but the failure count is unchanged.
  if (prev.errorCount > 0 && current.errorCount === prev.errorCount && history.length >= 2) {
    const prevPrev = history[history.length - 2]!
    if (prevPrev.errorCount === prev.errorCount) {
      return { stuck: true, reason: 'repeated_diagnostic' }
    }
  }

  // 3. Same file patched 3+ times across history + current
  const allRepairedFiles = [...history.flatMap(r => r.repairedFiles), ...current.repairedFiles]
  const fileCounts = new Map<string, number>()
  for (const f of allRepairedFiles) fileCounts.set(f, (fileCounts.get(f) ?? 0) + 1)
  for (const [, count] of fileCounts) {
    if (count >= 3) return { stuck: true, reason: 'same_file_repeated' }
  }

  // 4. Alternating diagnostic pattern (A→B→A across last 3)
  if (history.length >= 2) {
    const prevPrev = history[history.length - 2]!
    if (
      current.diagnosticSigs.length > 0 &&
      prevPrev.diagnosticSigs.length > 0 &&
      current.diagnosticSigs.some(sig => prevPrev.diagnosticSigs.includes(sig)) &&
      prev.diagnosticSigs.some(sig => !current.diagnosticSigs.includes(sig))
    ) {
      return { stuck: true, reason: 'alternating_diagnostic' }
    }
  }

  return { stuck: false, reason: null }
}
