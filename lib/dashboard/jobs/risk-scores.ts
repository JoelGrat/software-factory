import type { SupabaseClient } from '@supabase/supabase-js'

interface ComponentSignals {
  componentId: string
  projectId: string
  missRate: number
  missFrequency: number
  observationCount: number
  daysSinceLastMiss: number | null
  dependencyCentrality: number
  changeFrequency30d: number
  modelConfidence: number
}

interface ScoredComponent {
  componentId: string
  riskScore: number
  tier: 'HIGH' | 'MEDIUM'
}

const K = 7

export function computeEffectiveMissRate(missRate: number, n: number): number {
  if (missRate === 0) return 0
  return missRate * (1 - Math.exp(-n / K))
}

export function computeRiskScore(inputs: {
  effectiveMissRate: number
  missFrequency: number
  dependencyCentrality: number
  changeFrequency: number
  modelConfidence: number
  recencyWeight: number
}): number {
  const {
    effectiveMissRate, missFrequency, dependencyCentrality,
    changeFrequency, modelConfidence, recencyWeight,
  } = inputs

  return (
    0.60 * effectiveMissRate * recencyWeight +
    0.10 * missFrequency * recencyWeight +
    0.15 * dependencyCentrality +
    0.10 * changeFrequency +
    0.05 * (1 - modelConfidence)
  )
}

export function assignTier(score: number): 'HIGH' | 'MEDIUM' | null {
  if (score >= 0.7) return 'HIGH'
  if (score >= 0.4) return 'MEDIUM'
  return null
}

export function applyHardCap(scored: ScoredComponent[]): ScoredComponent[] {
  const highs = scored.filter(s => s.tier === 'HIGH').sort((a, b) => b.riskScore - a.riskScore)
  if (highs.length <= 2) return scored

  const toDowngrade = new Set(highs.slice(2).map(s => s.componentId))
  return scored.map(s => toDowngrade.has(s.componentId) ? { ...s, tier: 'MEDIUM' } : s)
}

function normalize(values: number[]): number[] {
  const max = Math.max(...values, 0.001)
  return values.map(v => v / max)
}

export async function computeAndStoreRiskScores(
  db: SupabaseClient,
  projectId: string
): Promise<void> {
  const { data: components } = await db
    .from('system_components')
    .select('id, is_anchored')
    .eq('project_id', projectId)
    .is('deleted_at', null)

  if (!components || components.length === 0) return

  const compIds = components.map(c => c.id)

  const { data: assignments } = await db
    .from('component_assignment')
    .select('component_id, confidence')
    .in('component_id', compIds)
    .eq('is_primary', true)

  const confidenceMap: Record<string, { total: number; n: number }> = {}
  for (const a of assignments ?? []) {
    if (!confidenceMap[a.component_id]) confidenceMap[a.component_id] = { total: 0, n: 0 }
    confidenceMap[a.component_id].total += a.confidence
    confidenceMap[a.component_id].n++
  }

  const { data: deps } = await db
    .from('component_dependencies')
    .select('to_id')
    .in('to_id', compIds)
    .is('deleted_at', null)

  const centralityMap: Record<string, number> = {}
  for (const d of deps ?? []) {
    centralityMap[d.to_id] = (centralityMap[d.to_id] ?? 0) + 1
  }

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const { data: recentSnapshots } = await db
    .from('analysis_result_snapshot')
    .select('components_affected, model_miss, completed_at, miss_rate')
    .gte('completed_at', thirtyDaysAgo)
    .in(
      'change_id',
      (await db.from('change_requests').select('id').eq('project_id', projectId)).data?.map(r => r.id) ?? []
    )

  const missCountMap: Record<string, number> = {}
  const appearedInMap: Record<string, number> = {}
  const lastMissDateMap: Record<string, Date> = {}

  for (const snap of recentSnapshots ?? []) {
    const affected: string[] = snap.components_affected ?? []
    for (const cid of affected) {
      appearedInMap[cid] = (appearedInMap[cid] ?? 0) + 1
    }
    const missed: Array<{ component_id: string }> = (snap.model_miss as any)?.missed ?? []
    for (const m of missed) {
      missCountMap[m.component_id] = (missCountMap[m.component_id] ?? 0) + 1
      const date = new Date(snap.completed_at)
      if (!lastMissDateMap[m.component_id] || date > lastMissDateMap[m.component_id]) {
        lastMissDateMap[m.component_id] = date
      }
    }
  }

  const totalSnapshots = (recentSnapshots ?? []).length || 1

  const rawSignals: ComponentSignals[] = components
    .filter(c => (appearedInMap[c.id] ?? 0) >= 2)
    .map(c => {
      const appeared = appearedInMap[c.id] ?? 0
      const missed = missCountMap[c.id] ?? 0
      const missRate = appeared > 0 ? missed / appeared : 0
      const conf = confidenceMap[c.id]
      const daysSinceLastMiss = lastMissDateMap[c.id]
        ? (Date.now() - lastMissDateMap[c.id].getTime()) / (1000 * 60 * 60 * 24)
        : null

      return {
        componentId: c.id,
        projectId,
        missRate,
        missFrequency: appeared / totalSnapshots,
        observationCount: appeared,
        daysSinceLastMiss,
        dependencyCentrality: centralityMap[c.id] ?? 0,
        changeFrequency30d: appeared,
        modelConfidence: conf ? conf.total / conf.n / 100 : 0.5,
      }
    })

  if (rawSignals.length === 0) return

  const normalizedCentrality = normalize(rawSignals.map(s => s.dependencyCentrality))
  const normalizedChangeFreq = normalize(rawSignals.map(s => s.changeFrequency30d))
  const normalizedMissFreq = normalize(rawSignals.map(s => s.missFrequency))

  const scored: ScoredComponent[] = rawSignals
    .map((s, i) => {
      const recencyWeight = s.daysSinceLastMiss != null
        ? Math.exp(-s.daysSinceLastMiss / 7)
        : 0.1
      const effectiveMissRate = computeEffectiveMissRate(s.missRate, s.observationCount)
      const rawScore = computeRiskScore({
        effectiveMissRate,
        missFrequency: normalizedMissFreq[i],
        dependencyCentrality: normalizedCentrality[i],
        changeFrequency: normalizedChangeFreq[i],
        modelConfidence: s.modelConfidence,
        recencyWeight,
      })
      const tier = assignTier(rawScore)
      return tier ? { componentId: s.componentId, riskScore: rawScore, tier } : null
    })
    .filter((s): s is ScoredComponent => s !== null)

  const capped = applyHardCap(scored)

  if (capped.length > 0) {
    await db.from('risk_scores').upsert(
      capped.map(s => ({
        component_id: s.componentId,
        project_id: projectId,
        risk_score: s.riskScore,
        tier: s.tier,
        computed_at: new Date().toISOString(),
      })),
      { onConflict: 'component_id' }
    )
  }

  const qualifyingIds = new Set(capped.map(s => s.componentId))
  const staleIds = compIds.filter(id => !qualifyingIds.has(id))
  if (staleIds.length > 0) {
    await db.from('risk_scores').delete().in('component_id', staleIds)
  }
}
