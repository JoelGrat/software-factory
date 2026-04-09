export interface ChangeRow {
  last_stage_started_at: Date | string | null
  expected_stage_duration_ms: number | null
}

export const FALLBACK_THRESHOLD_MS = 10 * 60 * 1000  // 10 minutes

/**
 * Pure function — determines whether a running analysis is stalled.
 * Uses stage-level timing: compares elapsed time since the current stage
 * started against 2× the expected stage duration.
 *
 * Called identically from:
 * - SSE connect (check all running changes for project)
 * - Dashboard page load (server-side)
 * - Background watchdog job (every 5 minutes)
 */
export function isStalled(change: ChangeRow): boolean {
  if (!change.last_stage_started_at) return false

  const threshold = change.expected_stage_duration_ms != null
    ? 2 * change.expected_stage_duration_ms
    : FALLBACK_THRESHOLD_MS

  const startedAt = change.last_stage_started_at instanceof Date
    ? change.last_stage_started_at
    : new Date(change.last_stage_started_at)

  const elapsed = Date.now() - startedAt.getTime()
  if (isNaN(elapsed)) {
    console.error('[watchdog] invalid last_stage_started_at:', change.last_stage_started_at)
    return false
  }
  return elapsed > threshold
}
