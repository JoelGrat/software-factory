import type { SupabaseClient } from '@supabase/supabase-js'
import { computeAndStoreRiskScores } from './risk-scores'
import { computeAndStoreActionItems } from './action-items'
import { computeAndStoreSystemSignals } from './system-signals'

/**
 * Runs all three background jobs for a project. Each job is isolated —
 * a failure in one does not prevent the others from running.
 */
export async function runDashboardJobs(
  db: SupabaseClient,
  projectId: string
): Promise<{ risk: 'ok' | 'error'; actions: 'ok' | 'error'; signals: 'ok' | 'error' }> {
  const results = { risk: 'ok' as 'ok' | 'error', actions: 'ok' as 'ok' | 'error', signals: 'ok' as 'ok' | 'error' }

  const [riskResult, actionsResult, signalsResult] = await Promise.allSettled([
    computeAndStoreRiskScores(db, projectId),
    computeAndStoreActionItems(db, projectId),
    computeAndStoreSystemSignals(db, projectId),
  ])

  if (riskResult.status === 'rejected') {
    console.error('[dashboard-jobs] risk scores failed:', riskResult.reason)
    results.risk = 'error'
  }
  if (actionsResult.status === 'rejected') {
    console.error('[dashboard-jobs] action items failed:', actionsResult.reason)
    results.actions = 'error'
  }
  if (signalsResult.status === 'rejected') {
    console.error('[dashboard-jobs] system signals failed:', signalsResult.reason)
    results.signals = 'error'
  }

  return results
}
