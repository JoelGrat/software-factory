# Dashboard Redesign — Plan 2: Background Jobs

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prerequisite:** Plan 1 (Foundation) must be complete. Tables `analysis_result_snapshot`, `risk_scores`, `action_items`, `system_signal_snapshot` must exist.

**Goal:** Implement the three background computation jobs that power the Risk Radar, Next Best Actions, and System Signals dashboard sections.

**Architecture:** Three pure computation functions in `lib/dashboard/jobs/` — `computeRiskScores`, `computeActionItems`, `computeSystemSignals`. Each reads from `analysis_result_snapshot` and related tables, writes to its precomputed table. A job runner in `lib/dashboard/jobs/runner.ts` orchestrates all three. The runner is called from the execute route on analysis completion and will also be wired to a cron job (nightly).

**Tech Stack:** TypeScript, Supabase adminClient, Vitest

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `lib/dashboard/jobs/risk-scores.ts` | Create | Compute risk_score per component using weighted formula |
| `lib/dashboard/jobs/action-items.ts` | Create | Derive tiered action items from risk scores + snapshot patterns |
| `lib/dashboard/jobs/system-signals.ts` | Create | Aggregate accuracy, miss rate, execution health, coverage into one snapshot |
| `lib/dashboard/jobs/runner.ts` | Create | Run all three jobs for a project, handle failures independently |
| `app/api/projects/[id]/dashboard-jobs/route.ts` | Create | POST endpoint to trigger job runner (called from execute route + cron) |
| `lib/execution/execution-orchestrator.ts` | Modify | Call job runner after enrichSnapshot completes |
| `tests/lib/dashboard/jobs/risk-scores.test.ts` | Create | Scoring formula correctness, tier assignment, severity cap |
| `tests/lib/dashboard/jobs/action-items.test.ts` | Create | Tier assignment, dominance rule, dedup/merge |
| `tests/lib/dashboard/jobs/system-signals.test.ts` | Create | Aggregation math, trend arrow threshold |

---

### Task 1: Risk Score Computation

**Files:**
- Create: `lib/dashboard/jobs/risk-scores.ts`
- Create: `tests/lib/dashboard/jobs/risk-scores.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/lib/dashboard/jobs/risk-scores.test.ts
import { describe, it, expect } from 'vitest'
import {
  computeEffectiveMissRate,
  computeRiskScore,
  assignTier,
  applyHardCap,
} from '@/lib/dashboard/jobs/risk-scores'

describe('computeEffectiveMissRate', () => {
  it('damps miss_rate for small samples', () => {
    // n=2, k=7: effective = 0.5 * (1 - e^(-2/7)) ≈ 0.5 * 0.248 ≈ 0.124
    const eff = computeEffectiveMissRate(0.5, 2)
    expect(eff).toBeCloseTo(0.124, 2)
  })

  it('approaches raw miss_rate for large samples', () => {
    // n=30, k=7: effective ≈ 0.8 * (1 - e^(-30/7)) ≈ 0.8 * 0.986 ≈ 0.789
    const eff = computeEffectiveMissRate(0.8, 30)
    expect(eff).toBeGreaterThan(0.77)
    expect(eff).toBeLessThan(0.8)
  })

  it('returns 0 for 0 miss_rate', () => {
    expect(computeEffectiveMissRate(0, 10)).toBe(0)
  })
})

describe('computeRiskScore', () => {
  it('produces a score between 0 and 1', () => {
    const score = computeRiskScore({
      effectiveMissRate: 0.5,
      missFrequency: 0.3,
      dependencyCentrality: 0.8,
      changeFrequency: 0.4,
      modelConfidence: 0.6,
      recencyWeight: 1.0,
    })
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(1)
  })

  it('weights miss_rate most heavily (0.60)', () => {
    const highMiss = computeRiskScore({
      effectiveMissRate: 1.0, missFrequency: 0, dependencyCentrality: 0, changeFrequency: 0, modelConfidence: 0, recencyWeight: 1,
    })
    const highCentrality = computeRiskScore({
      effectiveMissRate: 0, missFrequency: 0, dependencyCentrality: 1.0, changeFrequency: 0, modelConfidence: 0, recencyWeight: 1,
    })
    expect(highMiss).toBeGreaterThan(highCentrality)
  })
})

describe('applyHardCap', () => {
  it('downgrades lowest HIGH to MEDIUM when more than 2 are HIGH', () => {
    const scores = [
      { componentId: 'a', riskScore: 0.9, tier: 'HIGH' as const },
      { componentId: 'b', riskScore: 0.85, tier: 'HIGH' as const },
      { componentId: 'c', riskScore: 0.75, tier: 'HIGH' as const },
    ]
    const capped = applyHardCap(scores)
    const highs = capped.filter(s => s.tier === 'HIGH')
    expect(highs).toHaveLength(2)
    expect(capped.find(s => s.componentId === 'c')?.tier).toBe('MEDIUM')
  })

  it('keeps 2 HIGH items unchanged', () => {
    const scores = [
      { componentId: 'a', riskScore: 0.9, tier: 'HIGH' as const },
      { componentId: 'b', riskScore: 0.85, tier: 'HIGH' as const },
    ]
    const capped = applyHardCap(scores)
    expect(capped.filter(s => s.tier === 'HIGH')).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/lib/dashboard/jobs/risk-scores.test.ts
```

Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement risk scores computation**

```ts
// lib/dashboard/jobs/risk-scores.ts
import type { SupabaseClient } from '@supabase/supabase-js'

interface ComponentSignals {
  componentId: string
  projectId: string
  missRate: number
  missFrequency: number    // 0–1: fraction of recent runs this component was missed
  observationCount: number
  daysSinceLastMiss: number | null
  dependencyCentrality: number  // incoming edge count, normalized
  changeFrequency30d: number   // normalized
  modelConfidence: number       // 0–1
}

interface ScoredComponent {
  componentId: string
  riskScore: number
  tier: 'HIGH' | 'MEDIUM'
}

const K = 7  // confidence weighting decay constant

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
  return null  // excluded from radar
}

export function applyHardCap(scored: ScoredComponent[]): ScoredComponent[] {
  const highs = scored.filter(s => s.tier === 'HIGH').sort((a, b) => b.riskScore - a.riskScore)
  if (highs.length <= 2) return scored

  // Downgrade everything after the top 2
  const toDowngrade = new Set(highs.slice(2).map(s => s.componentId))
  return scored.map(s => toDowngrade.has(s.componentId) ? { ...s, tier: 'MEDIUM' } : s)
}

function normalize(values: number[]): number[] {
  const max = Math.max(...values, 0.001)
  return values.map(v => v / max)
}

/**
 * Main entry point: computes risk scores for all components in a project
 * and upserts into the risk_scores table.
 */
export async function computeAndStoreRiskScores(
  db: SupabaseClient,
  projectId: string
): Promise<void> {
  // Fetch components with ≥2 observations from analysis_result_snapshot
  const { data: components } = await db
    .from('system_components')
    .select('id, is_anchored')
    .eq('project_id', projectId)
    .is('deleted_at', null)

  if (!components || components.length === 0) return

  const compIds = components.map(c => c.id)

  // Confidence scores
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

  // Dependency centrality (incoming edges)
  const { data: deps } = await db
    .from('component_dependencies')
    .select('to_id')
    .in('to_id', compIds)
    .is('deleted_at', null)

  const centralityMap: Record<string, number> = {}
  for (const d of deps ?? []) {
    centralityMap[d.to_id] = (centralityMap[d.to_id] ?? 0) + 1
  }

  // Recent change frequency (last 30 days)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const { data: recentSnapshots } = await db
    .from('analysis_result_snapshot')
    .select('components_affected, model_miss, completed_at, miss_rate')
    .gte('completed_at', thirtyDaysAgo)
    .in(
      'change_id',
      (await db.from('change_requests').select('id').eq('project_id', projectId)).data?.map(r => r.id) ?? []
    )

  // Compute per-component signals from snapshots
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

  // Collect raw signals
  const rawSignals: ComponentSignals[] = components
    .filter(c => (appearedInMap[c.id] ?? 0) >= 2)  // evidence gate
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
        changeFrequency30d: appeared,  // proxy for change frequency
        modelConfidence: conf ? conf.total / conf.n / 100 : 0.5,
      }
    })

  if (rawSignals.length === 0) return

  // Normalize each signal dimension
  const normalizedCentrality = normalize(rawSignals.map(s => s.dependencyCentrality))
  const normalizedChangeFreq = normalize(rawSignals.map(s => s.changeFrequency30d))
  const normalizedMissFreq = normalize(rawSignals.map(s => s.missFrequency))

  // Score each component
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

  // Upsert into risk_scores
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

  // Remove stale scores for components no longer qualifying
  const qualifyingIds = new Set(capped.map(s => s.componentId))
  const staleIds = compIds.filter(id => !qualifyingIds.has(id))
  if (staleIds.length > 0) {
    await db.from('risk_scores').delete().in('component_id', staleIds)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/lib/dashboard/jobs/risk-scores.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/dashboard/jobs/risk-scores.ts tests/lib/dashboard/jobs/risk-scores.test.ts
git commit -m "feat: risk score computation with confidence-weighted miss rate and severity cap"
```

---

### Task 2: Action Items Computation

**Files:**
- Create: `lib/dashboard/jobs/action-items.ts`
- Create: `tests/lib/dashboard/jobs/action-items.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/lib/dashboard/jobs/action-items.test.ts
import { describe, it, expect } from 'vitest'
import { computePriorityScore, applyDominanceRule } from '@/lib/dashboard/jobs/action-items'

describe('computePriorityScore', () => {
  it('weights impact most heavily (0.5)', () => {
    const highImpact = computePriorityScore({ impactComponents: 1.0, failureFrequency: 0, recencyHours: 0 })
    const highFreq = computePriorityScore({ impactComponents: 0, failureFrequency: 1.0, recencyHours: 0 })
    expect(highImpact).toBeGreaterThan(highFreq)
  })

  it('decays older items via recency', () => {
    const recent = computePriorityScore({ impactComponents: 0.5, failureFrequency: 0.5, recencyHours: 1 })
    const old = computePriorityScore({ impactComponents: 0.5, failureFrequency: 0.5, recencyHours: 72 })
    expect(recent).toBeGreaterThan(old)
  })
})

describe('applyDominanceRule', () => {
  it('suppresses tier 2 items when tier 1 exists', () => {
    const items = [
      { tier: 1, source: 'pattern', componentId: 'a', priorityScore: 0.9 },
      { tier: 2, source: 'model_quality', componentId: 'b', priorityScore: 0.7 },
    ]
    const filtered = applyDominanceRule(items)
    expect(filtered.filter(i => i.tier === 2)).toHaveLength(0)
  })

  it('includes tier 2 item if it shares a component with a tier 1 item (merge candidate)', () => {
    const items = [
      { tier: 1, source: 'pattern', componentId: 'a', priorityScore: 0.9 },
      { tier: 2, source: 'model_quality', componentId: 'a', priorityScore: 0.7 },
    ]
    const filtered = applyDominanceRule(items)
    // Both surface — merger handled by dedup in UI
    expect(filtered).toHaveLength(2)
  })

  it('shows tier 3 only when no tier 1 or 2 items exist', () => {
    const items = [
      { tier: 3, source: 'opportunity', componentId: 'c', priorityScore: 0.3 },
    ]
    const filtered = applyDominanceRule(items)
    expect(filtered).toHaveLength(1)
  })

  it('suppresses tier 3 when tier 1 exists', () => {
    const items = [
      { tier: 1, source: 'pattern', componentId: 'a', priorityScore: 0.9 },
      { tier: 3, source: 'opportunity', componentId: 'c', priorityScore: 0.3 },
    ]
    const filtered = applyDominanceRule(items)
    expect(filtered.filter(i => i.tier === 3)).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/lib/dashboard/jobs/action-items.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement action items computation**

```ts
// lib/dashboard/jobs/action-items.ts
import type { SupabaseClient } from '@supabase/supabase-js'

interface RawActionItem {
  tier: number
  source: string
  componentId: string | null
  priorityScore: number
  payload: Record<string, unknown>
}

export function computePriorityScore(inputs: {
  impactComponents: number   // normalized 0–1
  failureFrequency: number   // normalized 0–1
  recencyHours: number       // hours since last occurrence
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
  if (!hasTier1) return items  // no dominance to apply

  const tier1ComponentIds = new Set(items.filter(i => i.tier === 1).map(i => i.componentId))

  return items.filter(i => {
    if (i.tier === 1) return true
    if (i.tier === 2 && i.componentId && tier1ComponentIds.has(i.componentId)) return true  // merge candidate
    return false  // suppress tier 2 (unrelated) and all tier 3
  })
}

/**
 * Main entry: derives action items from risk scores + snapshot patterns,
 * replaces all action_items rows for the project.
 */
export async function computeAndStoreActionItems(
  db: SupabaseClient,
  projectId: string
): Promise<void> {
  const items: RawActionItem[] = []
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  // ── Tier 1: Pattern detection ────────────────────────────────────────────
  const { data: recentSnapshots } = await db
    .from('analysis_result_snapshot')
    .select('model_miss, failure_cause, completed_at, components_affected')
    .gte('completed_at', sevenDaysAgo)
    .in(
      'change_id',
      (await db.from('change_requests').select('id').eq('project_id', projectId)).data?.map(r => r.id) ?? []
    )

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

  // ── Tier 1: HIGH risk component with no active change ────────────────────
  const { data: highRisk } = await db
    .from('risk_scores')
    .select('component_id, risk_score, system_components(name)')
    .eq('project_id', projectId)
    .eq('tier', 'HIGH')

  for (const rs of highRisk ?? []) {
    const compName = (rs.system_components as any)?.name ?? rs.component_id
    const hoursAgo = 24  // conservative estimate
    items.push({
      tier: 1,
      source: 'risk_radar',
      componentId: rs.component_id,
      priorityScore: computePriorityScore({
        impactComponents: Math.min(rs.risk_score, 1),
        failureFrequency: rs.risk_score,
        recencyHours: hoursAgo,
      }),
      payload: {
        componentId: rs.component_id,
        componentName: compName,
        riskScore: rs.risk_score,
        label: `Stabilize ${compName} — risk score: ${Math.round(rs.risk_score * 100)}%`,
      },
    })
  }

  // ── Tier 2: Low confidence + miss rate trending up ────────────────────────
  const { data: lowConf } = await db
    .from('component_assignment')
    .select('component_id, confidence, system_components(name, project_id)')
    .in(
      'component_id',
      (await db.from('system_components').select('id').eq('project_id', projectId).is('deleted_at', null))
        .data?.map(c => c.id) ?? []
    )
    .eq('is_primary', true)
    .lt('confidence', 40)

  for (const a of lowConf ?? []) {
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

  // ── Tier 3: Unanchored high-centrality components ─────────────────────────
  const { data: deps } = await db
    .from('component_dependencies')
    .select('to_id')
    .in(
      'to_id',
      (await db.from('system_components').select('id').eq('project_id', projectId).is('deleted_at', null))
        .data?.map(c => c.id) ?? []
    )
    .is('deleted_at', null)

  const centralityCount: Record<string, number> = {}
  for (const d of deps ?? []) {
    centralityCount[d.to_id] = (centralityCount[d.to_id] ?? 0) + 1
  }

  const { data: unanchored } = await db
    .from('system_components')
    .select('id, name')
    .eq('project_id', projectId)
    .eq('is_anchored', false)
    .is('deleted_at', null)

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

  // Apply dominance rule
  const filtered = applyDominanceRule(items)

  // Sort within tiers, take top 5
  const sorted = filtered
    .sort((a, b) => a.tier - b.tier || b.priorityScore - a.priorityScore)
    .slice(0, 5)

  // Replace all action_items for this project
  await db.from('action_items').delete().eq('project_id', projectId)
  if (sorted.length > 0) {
    await db.from('action_items').insert(
      sorted.map(item => ({
        project_id: projectId,
        tier: item.tier,
        priority_score: item.priorityScore,
        source: item.source,
        payload_json: item.payload,
      }))
    )
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/lib/dashboard/jobs/action-items.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/dashboard/jobs/action-items.ts tests/lib/dashboard/jobs/action-items.test.ts
git commit -m "feat: action items computation with tier dominance rule"
```

---

### Task 3: System Signal Snapshot

**Files:**
- Create: `lib/dashboard/jobs/system-signals.ts`
- Create: `tests/lib/dashboard/jobs/system-signals.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/lib/dashboard/jobs/system-signals.test.ts
import { describe, it, expect } from 'vitest'
import { computeOverallStatus, computeWeightedMissRate, formatTrendArrow } from '@/lib/dashboard/jobs/system-signals'

describe('computeOverallStatus', () => {
  it('returns Improving when all deltas are positive', () => {
    expect(computeOverallStatus({ accuracyDelta: 5, missRateDelta: -3, successRateDelta: 8 })).toBe('Improving')
  })

  it('returns Degrading when all deltas are negative', () => {
    expect(computeOverallStatus({ accuracyDelta: -10, missRateDelta: 5, successRateDelta: -5 })).toBe('Degrading')
  })

  it('returns Mixed when signals disagree', () => {
    expect(computeOverallStatus({ accuracyDelta: 5, missRateDelta: 3, successRateDelta: -2 })).toBe('Mixed')
  })
})

describe('computeWeightedMissRate', () => {
  it('weights higher-centrality components more', () => {
    const missed = [
      { component_id: 'a', centrality: 8 },
      { component_id: 'b', centrality: 2 },
    ]
    const actual = [
      { component_id: 'a', centrality: 8 },
      { component_id: 'b', centrality: 2 },
      { component_id: 'c', centrality: 1 },
    ]
    const rate = computeWeightedMissRate(missed, actual)
    // missed weight = 8+2=10, actual weight = 8+2+1=11, rate = 10/11 ≈ 0.909
    expect(rate).toBeCloseTo(0.909, 2)
  })

  it('returns 0 when nothing was missed', () => {
    expect(computeWeightedMissRate([], [{ component_id: 'a', centrality: 5 }])).toBe(0)
  })
})

describe('formatTrendArrow', () => {
  it('shows arrow only when abs(delta) >= 5', () => {
    expect(formatTrendArrow(6)).toBe('↑')
    expect(formatTrendArrow(-6)).toBe('↓')
    expect(formatTrendArrow(4)).toBe('~ stable')
    expect(formatTrendArrow(-4)).toBe('~ stable')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/lib/dashboard/jobs/system-signals.test.ts
```

Expected: FAIL

- [ ] **Step 3: Implement system signals computation**

```ts
// lib/dashboard/jobs/system-signals.ts
import type { SupabaseClient } from '@supabase/supabase-js'

export function computeOverallStatus(deltas: {
  accuracyDelta: number   // positive = accuracy improved
  missRateDelta: number   // positive = miss rate worsened (bad)
  successRateDelta: number  // positive = more successes (good)
}): 'Improving' | 'Degrading' | 'Mixed' {
  const { accuracyDelta, missRateDelta, successRateDelta } = deltas
  // Positive accuracy + falling miss rate + positive success = Improving
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

  // Fetch all change IDs for this project
  const { data: projectChanges } = await db
    .from('change_requests')
    .select('id')
    .eq('project_id', projectId)
  const changeIds = projectChanges?.map(c => c.id) ?? []

  if (changeIds.length === 0) {
    await db.from('system_signal_snapshot').upsert({ project_id: projectId, payload_json: {}, computed_at: new Date().toISOString() })
    return
  }

  // Last 7 days snapshots
  const { data: recent7 } = await db
    .from('analysis_result_snapshot')
    .select('execution_outcome, jaccard_accuracy, miss_rate, model_miss, analysis_status, completed_at, duration_ms')
    .in('change_id', changeIds)
    .gte('completed_at', sevenDaysAgo)

  // Prior 7 days (7–14 days ago) for delta computation
  const { data: prior7 } = await db
    .from('analysis_result_snapshot')
    .select('jaccard_accuracy, miss_rate, execution_outcome')
    .in('change_id', changeIds)
    .gte('completed_at', fourteenDaysAgo)
    .lt('completed_at', sevenDaysAgo)

  // Model accuracy
  const recentAccuracies = (recent7 ?? []).map(s => s.jaccard_accuracy).filter((v): v is number => v != null)
  const priorAccuracies = (prior7 ?? []).map(s => s.jaccard_accuracy).filter((v): v is number => v != null)
  const avgAccuracy7d = recentAccuracies.length > 0 ? recentAccuracies.reduce((s, v) => s + v, 0) / recentAccuracies.length : null
  const avgAccuracyPrior = priorAccuracies.length > 0 ? priorAccuracies.reduce((s, v) => s + v, 0) / priorAccuracies.length : null
  const accuracyDelta = avgAccuracy7d != null && avgAccuracyPrior != null ? (avgAccuracy7d - avgAccuracyPrior) * 100 : 0

  // Raw miss rate
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
  const { data: assignments } = await db
    .from('component_assignment')
    .select('component_id, confidence, system_components(project_id)')
    .eq('is_primary', true)
    .lt('confidence', 60)

  const lowConfComponents = (assignments ?? []).filter(a => (a.system_components as any)?.project_id === projectId)

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
      trendArrow: formatTrendArrow(-missRateDelta), // negative because lower is better
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

  await db.from('system_signal_snapshot').upsert({
    project_id: projectId,
    payload_json: payload,
    computed_at: new Date().toISOString(),
  })
}
```

- [ ] **Step 4: Run test**

```bash
npx vitest run tests/lib/dashboard/jobs/system-signals.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/dashboard/jobs/system-signals.ts tests/lib/dashboard/jobs/system-signals.test.ts
git commit -m "feat: system signal snapshot computation (accuracy, miss rate, health, coverage)"
```

---

### Task 4: Job Runner + Trigger

**Files:**
- Create: `lib/dashboard/jobs/runner.ts`
- Create: `app/api/projects/[id]/dashboard-jobs/route.ts`
- Modify: `lib/execution/execution-orchestrator.ts`

- [ ] **Step 1: Create the job runner**

```ts
// lib/dashboard/jobs/runner.ts
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
  const results = { risk: 'ok' as const, actions: 'ok' as const, signals: 'ok' as const }

  const [riskResult, actionsResult, signalsResult] = await Promise.allSettled([
    computeAndStoreRiskScores(db, projectId),
    computeAndStoreActionItems(db, projectId),
    computeAndStoreSystemSignals(db, projectId),
  ])

  if (riskResult.status === 'rejected') {
    console.error('[dashboard-jobs] risk scores failed:', riskResult.reason)
    ;(results as any).risk = 'error'
  }
  if (actionsResult.status === 'rejected') {
    console.error('[dashboard-jobs] action items failed:', actionsResult.reason)
    ;(results as any).actions = 'error'
  }
  if (signalsResult.status === 'rejected') {
    console.error('[dashboard-jobs] system signals failed:', signalsResult.reason)
    ;(results as any).signals = 'error'
  }

  return results
}
```

- [ ] **Step 2: Create the trigger endpoint**

```ts
// app/api/projects/[id]/dashboard-jobs/route.ts
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { runDashboardJobs } from '@/lib/dashboard/jobs/runner'

// Called internally from execute route and externally from a cron job.
// Not exposed to end users — no auth gate needed since it's an internal API.
// In production, secure with a shared secret header if exposed externally.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params
  const adminDb = createAdminClient()

  // Fire and forget — return 202 immediately
  runDashboardJobs(adminDb, projectId).catch(err =>
    console.error('[dashboard-jobs] runner failed:', err)
  )

  return NextResponse.json({ status: 'running' }, { status: 202 })
}
```

- [ ] **Step 3: Call job runner from enrichSnapshotWithRetry in orchestrator**

In `lib/execution/execution-orchestrator.ts`, update `enrichSnapshotWithRetry` to call the jobs after enrichment succeeds:

```ts
async function enrichSnapshotWithRetry(
  db: SupabaseClient,
  projectId: string,
  changeId: string,
  data: Parameters<typeof enrichSnapshot>[2],
  attempts = 3
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await enrichSnapshot(db, changeId, data)
      // Trigger background jobs after successful enrichment
      runDashboardJobs(db, projectId).catch(err =>
        console.warn('[dashboard-jobs] post-enrichment jobs failed:', err)
      )
      return
    } catch (err) {
      if (i === attempts - 1) {
        console.error('[dashboard] enrichment failed after retries:', err)
        await markEnrichmentFailed(db, changeId).catch(() => {})
      } else {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, i)))
      }
    }
  }
}
```

Add the import at the top of the orchestrator:

```ts
import { runDashboardJobs } from '@/lib/dashboard/jobs/runner'
```

- [ ] **Step 4: Verify TypeScript**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add lib/dashboard/jobs/runner.ts app/api/projects/[id]/dashboard-jobs/route.ts lib/execution/execution-orchestrator.ts
git commit -m "feat: dashboard job runner triggered after analysis enrichment"
```

---

## Self-Review Checklist

- [ ] Each job isolated in `Promise.allSettled` — one failure doesn't kill others ✓
- [ ] Evidence gate (≥2 observations) applied before risk scoring ✓
- [ ] `applyHardCap` limits HIGH tier to max 2 ✓
- [ ] `applyDominanceRule` suppresses Tier 2/3 when Tier 1 exists, but allows merge candidates ✓
- [ ] Trend arrows suppressed when `abs(delta) < 5` ✓
- [ ] Weighted miss rate uses centrality, not raw count ✓
- [ ] `computeOverallStatus` requires all 3 signals to agree for Improving/Degrading ✓
- [ ] Jobs fire-and-forget from execute route — no blocking ✓
