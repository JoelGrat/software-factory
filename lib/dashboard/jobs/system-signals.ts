import type { SupabaseClient } from '@supabase/supabase-js'

export function computeOverallStatus(deltas: {
  accuracyDelta: number
  missRateDelta: number
  successRateDelta: number
}): 'Improving' | 'Degrading' | 'Mixed' {
  const { accuracyDelta, missRateDelta, successRateDelta } = deltas
  const goodSignals = [accuracyDelta > 0, missRateDelta < 0, successRateDelta > 0].filter(Boolean).length
  const badSignals = [accuracyDelta < 0, missRateDelta > 0, successRateDelta < 0].filter(Boolean).length
  if (goodSignals === 3) return 'Improving'
  if (badSignals === 3) return 'Degrading'
  return 'Mixed'
}

export function computeWeightedMissRate(
  missed: Array<{ component_id: string; centrality: number }>,
  actual: Array<{ component_id: string; centrality: number }>
): number {
  const totalActualWeight = actual.reduce((s, c) => s + c.centrality, 0)
  if (totalActualWeight === 0) return 0
  const missedWeight = missed.reduce((s, c) => s + c.centrality, 0)
  return missedWeight / totalActualWeight
}

export function formatTrendArrow(delta: number): string {
  if (Math.abs(delta) < 5) return '~ stable'
  return delta > 0 ? '↑' : '↓'
}

export async function computeAndStoreSystemSignals(
  db: SupabaseClient,
  projectId: string
): Promise<void> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()

  const { data: projectChanges, error: changesError } = await db
    .from('change_requests')
    .select('id')
    .eq('project_id', projectId)
  if (changesError) { console.error('[system-signals] change_requests query failed:', changesError); return }
  const changeIds = projectChanges?.map(c => c.id) ?? []

  if (changeIds.length === 0) {
    await db.from('system_signal_snapshot').upsert({
      project_id: projectId,
      payload_json: {},
      computed_at: new Date().toISOString(),
    })
    return
  }

  const { data: recent7, error: recent7Error } = await db
    .from('analysis_result_snapshot')
    .select('execution_outcome, jaccard_accuracy, miss_rate, model_miss, analysis_status, completed_at, duration_ms')
    .in('change_id', changeIds)
    .gte('completed_at', sevenDaysAgo)
  if (recent7Error) { console.error('[system-signals] recent7 query failed:', recent7Error); return }

  const { data: prior7, error: prior7Error } = await db
    .from('analysis_result_snapshot')
    .select('jaccard_accuracy, miss_rate, execution_outcome')
    .in('change_id', changeIds)
    .gte('completed_at', fourteenDaysAgo)
    .lt('completed_at', sevenDaysAgo)
  if (prior7Error) { console.error('[system-signals] prior7 query failed:', prior7Error); return }

  // Model accuracy
  const recentAccuracies = (recent7 ?? []).map(s => s.jaccard_accuracy).filter((v): v is number => v != null)
  const priorAccuracies = (prior7 ?? []).map(s => s.jaccard_accuracy).filter((v): v is number => v != null)
  const avgAccuracy7d = recentAccuracies.length > 0 ? recentAccuracies.reduce((s, v) => s + v, 0) / recentAccuracies.length : null
  const avgAccuracyPrior = priorAccuracies.length > 0 ? priorAccuracies.reduce((s, v) => s + v, 0) / priorAccuracies.length : null
  const accuracyDelta = avgAccuracy7d != null && avgAccuracyPrior != null ? (avgAccuracy7d - avgAccuracyPrior) * 100 : 0

  // Miss rate
  const recentMissRates = (recent7 ?? []).map(s => s.miss_rate).filter((v): v is number => v != null)
  const priorMissRates = (prior7 ?? []).map(s => s.miss_rate).filter((v): v is number => v != null)
  const avgMissRate7d = recentMissRates.length > 0 ? recentMissRates.reduce((s, v) => s + v, 0) / recentMissRates.length : null
  const avgMissRatePrior = priorMissRates.length > 0 ? priorMissRates.reduce((s, v) => s + v, 0) / priorMissRates.length : null
  const missRateDelta = avgMissRate7d != null && avgMissRatePrior != null ? (avgMissRate7d - avgMissRatePrior) * 100 : 0

  // Execution health
  const total7d = (recent7 ?? []).length
  const successes = (recent7 ?? []).filter(s => s.execution_outcome === 'success').length
  const stalls = (recent7 ?? []).filter(s => s.analysis_status === 'stalled').length
  const failures = total7d - successes - stalls
  const successRate = total7d > 0 ? successes / total7d : null
  const priorSuccesses = (prior7 ?? []).filter(s => s.execution_outcome === 'success').length
  const priorTotal = (prior7 ?? []).length
  const priorSuccessRate = priorTotal > 0 ? priorSuccesses / priorTotal : null
  const successRateDelta = successRate != null && priorSuccessRate != null ? (successRate - priorSuccessRate) * 100 : 0

  // Avg execution time
  const durations = (recent7 ?? []).map(s => s.duration_ms).filter((v): v is number => v != null)
  const avgDurationMs = durations.length > 0 ? durations.reduce((s, v) => s + v, 0) / durations.length : null

  // Coverage quality
  const { data: compRows } = await db
    .from('system_components')
    .select('id')
    .eq('project_id', projectId)
    .is('deleted_at', null)
  const compIdList = compRows?.map(c => c.id) ?? []

  let lowConfComponents: unknown[] = []
  if (compIdList.length > 0) {
    const { data: assignments, error: assignError } = await db
      .from('component_assignment')
      .select('component_id, confidence')
      .in('component_id', compIdList)
      .eq('is_primary', true)
      .lt('confidence', 60)
    if (assignError) console.error('[system-signals] assignments query failed:', assignError)
    lowConfComponents = assignments ?? []
  }

  // Overall status
  const overallStatus = computeOverallStatus({ accuracyDelta, missRateDelta, successRateDelta })

  const payload = {
    overallStatus,
    modelAccuracy: {
      avg7d: avgAccuracy7d,
      delta: accuracyDelta,
      trendArrow: formatTrendArrow(accuracyDelta),
      runCount: recentAccuracies.length,
    },
    missRate: {
      avg7d: avgMissRate7d,
      delta: missRateDelta,
      trendArrow: formatTrendArrow(-missRateDelta),
    },
    executionHealth: {
      successRate: successRate != null ? Math.round(successRate * 100) : null,
      failureRate: total7d > 0 ? Math.round((failures / total7d) * 100) : null,
      stallRate: total7d > 0 ? Math.round((stalls / total7d) * 100) : null,
      total7d,
      avgDurationMs,
      successRateDelta,
    },
    coverageQuality: {
      lowConfidenceCount: lowConfComponents.length,
    },
    computedAt: new Date().toISOString(),
  }

  const { error: upsertError } = await db.from('system_signal_snapshot').upsert({
    project_id: projectId,
    payload_json: payload,
    computed_at: new Date().toISOString(),
  })
  if (upsertError) console.error('[system-signals] upsert failed:', upsertError)
}
