import type { SupabaseClient } from '@supabase/supabase-js'

export interface RawActionItem {
  tier: number
  source: string
  componentId: string | null
  priorityScore: number
  payload: Record<string, unknown>
}

export function computePriorityScore(inputs: {
  impactComponents: number
  failureFrequency: number
  recencyHours: number
}): number {
  const recencyWeight = Math.exp(-inputs.recencyHours / 24)
  return (
    0.5 * inputs.impactComponents +
    0.3 * inputs.failureFrequency +
    0.2 * recencyWeight
  )
}

export function applyDominanceRule(items: RawActionItem[]): RawActionItem[] {
  const hasTier1 = items.some(i => i.tier === 1)
  if (!hasTier1) return items

  const tier1ComponentIds = new Set(items.filter(i => i.tier === 1).map(i => i.componentId))

  return items.filter(i => {
    if (i.tier === 1) return true
    if (i.tier === 2 && i.componentId && tier1ComponentIds.has(i.componentId)) return true
    return false
  })
}

export async function computeAndStoreActionItems(
  db: SupabaseClient,
  projectId: string
): Promise<void> {
  const items: RawActionItem[] = []
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  // Fetch project change IDs
  const { data: projectChanges, error: changesError } = await db
    .from('change_requests')
    .select('id')
    .eq('project_id', projectId)
  if (changesError) { console.error('[action-items] change_requests query failed:', changesError); return }
  const changeIds = projectChanges?.map(c => c.id) ?? []

  // ── Tier 1: Pattern detection ────────────────────────────────────────────
  if (changeIds.length === 0) {
    // no changes means no snapshots, skip pattern detection
  } else {
    const { data: recentSnapshots, error: snapError } = await db
      .from('analysis_result_snapshot')
      .select('model_miss, failure_cause, completed_at, components_affected')
      .gte('completed_at', sevenDaysAgo)
      .in('change_id', changeIds)
    if (snapError) { console.error('[action-items] snapshots query failed:', snapError); return }

    const errorTypeCounts: Record<string, { count: number; components: Set<string>; lastAt: Date }> = {}
    const total = (recentSnapshots ?? []).length

    for (const snap of recentSnapshots ?? []) {
      const cause = snap.failure_cause as { error_type?: string; component_id?: string } | null
      if (cause?.error_type) {
        const et = cause.error_type
        if (!errorTypeCounts[et]) errorTypeCounts[et] = { count: 0, components: new Set(), lastAt: new Date(0) }
        errorTypeCounts[et].count++
        if (cause.component_id) errorTypeCounts[et].components.add(cause.component_id)
        const d = new Date(snap.completed_at)
        if (d > errorTypeCounts[et].lastAt) errorTypeCounts[et].lastAt = d
      }
    }

    for (const [errorType, data] of Object.entries(errorTypeCounts)) {
      if (data.count >= 2 && total > 0 && data.count / total >= 0.4) {
        const hoursAgo = (Date.now() - data.lastAt.getTime()) / (1000 * 60 * 60)
        const affectedComponents = Array.from(data.components)
        items.push({
          tier: 1,
          source: 'pattern',
          componentId: affectedComponents[0] ?? null,
          priorityScore: computePriorityScore({
            impactComponents: Math.min(affectedComponents.length / 5, 1),
            failureFrequency: data.count / total,
            recencyHours: hoursAgo,
          }),
          payload: {
            errorType,
            count: data.count,
            total,
            affectedComponents,
            lastOccurredAt: data.lastAt.toISOString(),
            label: `Fix recurring \`${errorType}\` in ${affectedComponents.slice(0, 2).join(', ')}`,
          },
        })
      }
    }
  }

  // ── Tier 1: HIGH risk component ────────────────────────────────────────
  const { data: highRisk, error: riskError } = await db
    .from('risk_scores')
    .select('component_id, risk_score, system_components(name)')
    .eq('project_id', projectId)
    .eq('tier', 'HIGH')
  if (riskError) console.error('[action-items] risk_scores query failed:', riskError)

  for (const rs of highRisk ?? []) {
    const compName = (rs.system_components as any)?.name ?? rs.component_id
    items.push({
      tier: 1,
      source: 'risk_radar',
      componentId: rs.component_id,
      priorityScore: computePriorityScore({
        impactComponents: Math.min(rs.risk_score, 1),
        failureFrequency: rs.risk_score,
        recencyHours: 24,
      }),
      payload: {
        componentId: rs.component_id,
        componentName: compName,
        riskScore: rs.risk_score,
        label: `Stabilize ${compName} — risk score: ${Math.round(rs.risk_score * 100)}%`,
      },
    })
  }

  // ── Tier 2: Low confidence ──────────────────────────────────────────────
  const { data: compIds } = await db
    .from('system_components')
    .select('id')
    .eq('project_id', projectId)
    .is('deleted_at', null)

  const compIdList = compIds?.map(c => c.id) ?? []

  let lowConf: { component_id: string; confidence: number; system_components: unknown }[] = []
  if (compIdList.length > 0) {
    const { data: lowConfData, error: lowConfError } = await db
      .from('component_assignment')
      .select('component_id, confidence, system_components(name, project_id)')
      .in('component_id', compIdList)
      .eq('is_primary', true)
      .lt('confidence', 40)
    if (lowConfError) console.error('[action-items] lowConf query failed:', lowConfError)
    lowConf = lowConfData ?? []
  }

  for (const a of lowConf) {
    const compName = (a.system_components as any)?.name ?? a.component_id
    items.push({
      tier: 2,
      source: 'model_quality',
      componentId: a.component_id,
      priorityScore: computePriorityScore({
        impactComponents: 0.3,
        failureFrequency: (100 - a.confidence) / 100,
        recencyHours: 48,
      }),
      payload: {
        componentId: a.component_id,
        componentName: compName,
        confidence: a.confidence,
        label: `Fix ${compName} boundary — confidence: ${a.confidence}%`,
      },
    })
  }

  // ── Tier 3: Unanchored high-centrality components ──────────────────────
  let deps: { to_id: string }[] = []
  if (compIdList.length > 0) {
    const { data: depsData, error: depsError } = await db
      .from('component_dependencies')
      .select('to_id')
      .in('to_id', compIdList)
      .is('deleted_at', null)
    if (depsError) console.error('[action-items] deps query failed:', depsError)
    deps = depsData ?? []
  }

  const centralityCount: Record<string, number> = {}
  for (const d of deps) {
    centralityCount[d.to_id] = (centralityCount[d.to_id] ?? 0) + 1
  }

  const { data: unanchored, error: unanchoredError } = await db
    .from('system_components')
    .select('id, name')
    .eq('project_id', projectId)
    .eq('is_anchored', false)
    .is('deleted_at', null)
  if (unanchoredError) console.error('[action-items] unanchored query failed:', unanchoredError)

  for (const c of unanchored ?? []) {
    const centrality = centralityCount[c.id] ?? 0
    if (centrality >= 4) {
      items.push({
        tier: 3,
        source: 'opportunity',
        componentId: c.id,
        priorityScore: computePriorityScore({
          impactComponents: Math.min(centrality / 10, 1),
          failureFrequency: 0,
          recencyHours: 168,
        }),
        payload: {
          componentId: c.id,
          componentName: c.name,
          centrality,
          label: `Anchor ${c.name} — referenced by ${centrality} components`,
        },
      })
    }
  }

  // Apply dominance rule, sort, cap at 5
  const filtered = applyDominanceRule(items)
  const sorted = filtered
    .sort((a, b) => a.tier - b.tier || b.priorityScore - a.priorityScore)
    .slice(0, 5)

  // Replace all action_items for this project
  const { error: deleteError } = await db.from('action_items').delete().eq('project_id', projectId)
  if (deleteError) { console.error('[action-items] delete failed:', deleteError); return }

  if (sorted.length > 0) {
    const { error: insertError } = await db.from('action_items').insert(
      sorted.map(item => ({
        project_id: projectId,
        tier: item.tier,
        priority_score: item.priorityScore,
        source: item.source,
        payload_json: item.payload,
      }))
    )
    if (insertError) console.error('[action-items] insert failed:', insertError)
  }
}
