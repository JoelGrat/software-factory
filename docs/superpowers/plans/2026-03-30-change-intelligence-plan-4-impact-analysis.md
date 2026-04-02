# Change Intelligence System — Plan 4: Impact Analysis Engine

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the impact analysis engine — a 4-phase async pipeline that maps a change request to affected system components, propagates impact through the file-level dependency graph, computes a risk score, detects migration requirements, and writes the full analysis to the database.

**Architecture:** Pure analysis functions (`file-bfs`, `component-aggregator`, `risk-scorer`, `migration-detector`) live in `lib/impact/` with no framework dependencies, making them fully unit-testable. An orchestrator `runImpactAnalysis` wires all phases and writes results to DB using a Supabase service-role client. A `component-mapper` (AI-assisted) maps change intent → component IDs + seed file IDs. Analysis is triggered fire-and-forget from `POST /api/change-requests` on creation and `POST /api/change-requests/[id]/analyze` for retries. The change detail UI stub is replaced with a full impact panel.

**Tech Stack:** Next.js 14 App Router, TypeScript, Supabase, Vitest, Claude/OpenAI (via existing `AIProvider`)

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `lib/impact/types.ts` | Create | All shared interfaces for the impact pipeline |
| `lib/impact/file-bfs.ts` | Create | File-level BFS with edge-type decay |
| `lib/impact/component-aggregator.ts` | Create | Maps reached file IDs → component weights |
| `lib/impact/risk-scorer.ts` | Create | Additive risk scoring formula |
| `lib/impact/migration-detector.ts` | Create | Regex-first, AI-fallback migration detection |
| `lib/impact/component-mapper.ts` | Create | Keyword + AI mapping: change intent → component IDs |
| `lib/impact/impact-analyzer.ts` | Create | Orchestrator: runs all 4 phases, writes to DB |
| `tests/lib/impact/file-bfs.test.ts` | Create | Unit tests for BFS |
| `tests/lib/impact/component-aggregator.test.ts` | Create | Unit tests for aggregator |
| `tests/lib/impact/risk-scorer.test.ts` | Create | Unit tests for risk scorer |
| `tests/lib/impact/migration-detector.test.ts` | Create | Unit tests for migration detector |
| `tests/lib/impact/component-mapper.test.ts` | Create | Unit tests for component mapper (mock DB + AI) |
| `tests/lib/impact/impact-analyzer.test.ts` | Create | Integration tests for orchestrator (mock DB + AI) |
| `app/api/change-requests/[id]/analyze/route.ts` | Create | POST: trigger/retry analysis |
| `app/api/change-requests/route.ts` | Modify | Auto-trigger analysis fire-and-forget on creation |
| `app/projects/[id]/changes/[changeId]/page.tsx` | Modify | Fetch impact + risk_factors + impact_components for initial load |
| `app/projects/[id]/changes/[changeId]/change-detail-view.tsx` | Modify | Replace stub with full impact panel |

---

### Task 1: Types + File BFS

**Files:**
- Create: `lib/impact/types.ts`
- Create: `lib/impact/file-bfs.ts`
- Create: `tests/lib/impact/file-bfs.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/lib/impact/file-bfs.test.ts
import { describe, it, expect } from 'vitest'
import { runFileBFS } from '@/lib/impact/file-bfs'
import type { SeedFile, FileGraphEdge } from '@/lib/impact/types'

describe('runFileBFS', () => {
  it('includes seed files at weight 1.0', () => {
    const seeds: SeedFile[] = [{ fileId: 'f1', reason: 'component_match' }]
    const result = runFileBFS(seeds, [])
    expect(result.reachedFileIds.get('f1')).toBe(1.0)
  })

  it('propagates static edges with 0.7 decay', () => {
    const seeds: SeedFile[] = [{ fileId: 'f1', reason: 'component_match' }]
    const edges: FileGraphEdge[] = [
      { from_file_id: 'f1', to_file_id: 'f2', edge_type: 'static' },
    ]
    const result = runFileBFS(seeds, edges)
    expect(result.reachedFileIds.get('f2')).toBeCloseTo(0.7)
  })

  it('propagates re-export edges with 0.8 decay', () => {
    const seeds: SeedFile[] = [{ fileId: 'f1', reason: 'component_match' }]
    const edges: FileGraphEdge[] = [
      { from_file_id: 'f1', to_file_id: 'f2', edge_type: 're-export' },
    ]
    const result = runFileBFS(seeds, edges)
    expect(result.reachedFileIds.get('f2')).toBeCloseTo(0.8)
  })

  it('stops propagation when weight drops below 0.1', () => {
    const seeds: SeedFile[] = [{ fileId: 'f1', reason: 'component_match' }]
    const edges: FileGraphEdge[] = [
      { from_file_id: 'f1', to_file_id: 'f2', edge_type: 'static' }, // 0.7
      { from_file_id: 'f2', to_file_id: 'f3', edge_type: 'static' }, // 0.49
      { from_file_id: 'f3', to_file_id: 'f4', edge_type: 'static' }, // 0.343
      { from_file_id: 'f4', to_file_id: 'f5', edge_type: 'static' }, // 0.24
      { from_file_id: 'f5', to_file_id: 'f6', edge_type: 'static' }, // 0.168
      { from_file_id: 'f6', to_file_id: 'f7', edge_type: 'static' }, // 0.117
      { from_file_id: 'f7', to_file_id: 'f8', edge_type: 'static' }, // 0.082 < 0.1 → STOP
    ]
    const result = runFileBFS(seeds, edges)
    expect(result.reachedFileIds.has('f8')).toBe(false)
    expect(result.reachedFileIds.has('f7')).toBe(true)
  })

  it('keeps max weight when multiple paths reach same file', () => {
    const seeds: SeedFile[] = [
      { fileId: 'f1', reason: 'component_match' },
      { fileId: 'f2', reason: 'component_match' },
    ]
    const edges: FileGraphEdge[] = [
      { from_file_id: 'f1', to_file_id: 'f3', edge_type: 'static' }, // 0.7
      { from_file_id: 'f2', to_file_id: 'f3', edge_type: 're-export' }, // 0.8
    ]
    const result = runFileBFS(seeds, edges)
    expect(result.reachedFileIds.get('f3')).toBeCloseTo(0.8)
  })

  it('counts dynamic imports but does not traverse them', () => {
    const seeds: SeedFile[] = [{ fileId: 'f1', reason: 'component_match' }]
    const edges: FileGraphEdge[] = [
      { from_file_id: 'f1', to_file_id: 'f2', edge_type: 'dynamic' },
    ]
    const result = runFileBFS(seeds, edges)
    expect(result.reachedFileIds.has('f2')).toBe(false)
    expect(result.dynamicImportCounts['f2']).toBe(1)
  })

  it('respects maxDepth', () => {
    const seeds: SeedFile[] = [{ fileId: 'f1', reason: 'component_match' }]
    const edges: FileGraphEdge[] = [
      { from_file_id: 'f1', to_file_id: 'f2', edge_type: 'static' },
      { from_file_id: 'f2', to_file_id: 'f3', edge_type: 'static' },
    ]
    const result = runFileBFS(seeds, edges, 1)
    expect(result.reachedFileIds.has('f2')).toBe(true)
    expect(result.reachedFileIds.has('f3')).toBe(false)
  })

  it('handles empty seeds gracefully', () => {
    const result = runFileBFS([], [])
    expect(result.reachedFileIds.size).toBe(0)
    expect(result.dynamicImportCounts).toEqual({})
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd C:/Users/joelg/softwareFactory_git
npx vitest run tests/lib/impact/file-bfs.test.ts 2>&1 | head -20
```

Expected: FAIL with "Cannot find module '@/lib/impact/file-bfs'"

- [ ] **Step 3: Create types.ts**

```typescript
// lib/impact/types.ts

export type SeedReason = 'keyword_match' | 'component_match' | 'direct_mention'
export type ImpactSource = 'seed' | 'file_graph'

export interface SeedFile {
  fileId: string
  reason: SeedReason
}

export interface FileGraphEdge {
  from_file_id: string
  to_file_id: string
  edge_type: string
}

export interface FileAssignment {
  file_id: string
  component_id: string
}

export interface FileBFSResult {
  reachedFileIds: Map<string, number>
  dynamicImportCounts: Record<string, number>
}

export interface MappedComponent {
  componentId: string
  name: string
  type: string
  confidence: number
  matchReason: string
}

export interface ComponentMapResult {
  seedFileIds: string[]
  components: MappedComponent[]
  aiUsed: boolean
}

export interface ComponentWeight {
  componentId: string
  weight: number
  source: ImpactSource
  sourceDetail: string
}

export interface RiskFactors {
  blastRadius: number
  unknownDepsCount: number
  hasLowConfidenceComponents: boolean
  componentTypes: string[]
  dynamicImportCount: number
}

export interface RiskScoreResult {
  score: number
  riskLevel: 'low' | 'medium' | 'high'
  primaryRiskFactor: string
  confidenceBreakdown: Record<string, number>
}
```

- [ ] **Step 4: Create file-bfs.ts**

```typescript
// lib/impact/file-bfs.ts
import type { SeedFile, FileGraphEdge, FileBFSResult } from './types'

const EDGE_DECAY: Record<string, number> = {
  static: 0.7,
  're-export': 0.8,
  component_dependency: 0.6,
}
const MIN_WEIGHT = 0.1

export function runFileBFS(
  seeds: SeedFile[],
  edges: FileGraphEdge[],
  maxDepth = 3
): FileBFSResult {
  const adjacency = new Map<string, Array<{ target: string; type: string }>>()
  for (const edge of edges) {
    if (!adjacency.has(edge.from_file_id)) adjacency.set(edge.from_file_id, [])
    adjacency.get(edge.from_file_id)!.push({ target: edge.to_file_id, type: edge.edge_type })
  }

  const reachedFileIds = new Map<string, number>()
  const dynamicImportCounts: Record<string, number> = {}

  const queue: Array<{ fileId: string; weight: number; depth: number }> = []
  for (const seed of seeds) {
    reachedFileIds.set(seed.fileId, 1.0)
    queue.push({ fileId: seed.fileId, weight: 1.0, depth: 0 })
  }

  while (queue.length > 0) {
    const { fileId, weight, depth } = queue.shift()!
    if (depth >= maxDepth) continue

    for (const { target, type } of adjacency.get(fileId) ?? []) {
      if (type === 'dynamic') {
        dynamicImportCounts[target] = (dynamicImportCounts[target] ?? 0) + 1
        continue
      }
      const decay = EDGE_DECAY[type] ?? 0.7
      const newWeight = weight * decay
      if (newWeight < MIN_WEIGHT) continue
      const existing = reachedFileIds.get(target) ?? 0
      if (newWeight > existing) {
        reachedFileIds.set(target, newWeight)
        queue.push({ fileId: target, weight: newWeight, depth: depth + 1 })
      }
    }
  }

  return { reachedFileIds, dynamicImportCounts }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npx vitest run tests/lib/impact/file-bfs.test.ts
```

Expected: 8 passing

- [ ] **Step 6: Commit**

```bash
git add lib/impact/types.ts lib/impact/file-bfs.ts tests/lib/impact/file-bfs.test.ts
git commit -m "feat: add impact analysis types and file BFS"
```

---

### Task 2: Component Aggregator

**Files:**
- Create: `lib/impact/component-aggregator.ts`
- Create: `tests/lib/impact/component-aggregator.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/lib/impact/component-aggregator.test.ts
import { describe, it, expect } from 'vitest'
import { aggregateComponents } from '@/lib/impact/component-aggregator'
import type { FileBFSResult, FileAssignment, MappedComponent } from '@/lib/impact/types'

function makeBfsResult(entries: Array<[string, number]>): FileBFSResult {
  return { reachedFileIds: new Map(entries), dynamicImportCounts: {} }
}

describe('aggregateComponents', () => {
  it('gives seed components weight 1.0 regardless of file graph', () => {
    const bfs = makeBfsResult([])
    const assignments: FileAssignment[] = []
    const seedComponents: MappedComponent[] = [{
      componentId: 'comp1', name: 'Auth', type: 'service', confidence: 90, matchReason: 'keyword: auth'
    }]
    const result = aggregateComponents(bfs, assignments, seedComponents)
    expect(result.find(c => c.componentId === 'comp1')?.weight).toBe(1.0)
    expect(result.find(c => c.componentId === 'comp1')?.source).toBe('seed')
  })

  it('maps reached files to their assigned components', () => {
    const bfs = makeBfsResult([['f1', 0.7], ['f2', 0.49]])
    const assignments: FileAssignment[] = [
      { file_id: 'f1', component_id: 'comp2' },
      { file_id: 'f2', component_id: 'comp3' },
    ]
    const result = aggregateComponents(bfs, assignments, [])
    expect(result.find(c => c.componentId === 'comp2')?.weight).toBeCloseTo(0.7)
    expect(result.find(c => c.componentId === 'comp3')?.weight).toBeCloseTo(0.49)
  })

  it('takes max weight when multiple files map to same component', () => {
    const bfs = makeBfsResult([['f1', 0.7], ['f2', 0.49]])
    const assignments: FileAssignment[] = [
      { file_id: 'f1', component_id: 'comp2' },
      { file_id: 'f2', component_id: 'comp2' },
    ]
    const result = aggregateComponents(bfs, assignments, [])
    const comp = result.find(c => c.componentId === 'comp2')
    expect(comp?.weight).toBeCloseTo(0.7)
  })

  it('seed weight (1.0) wins over file_graph weight for same component', () => {
    const bfs = makeBfsResult([['f1', 0.5]])
    const assignments: FileAssignment[] = [{ file_id: 'f1', component_id: 'comp1' }]
    const seedComponents: MappedComponent[] = [{
      componentId: 'comp1', name: 'Auth', type: 'service', confidence: 90, matchReason: 'keyword: auth'
    }]
    const result = aggregateComponents(bfs, assignments, seedComponents)
    const comp = result.find(c => c.componentId === 'comp1')
    expect(comp?.weight).toBe(1.0)
    expect(comp?.source).toBe('seed')
  })

  it('ignores files with no component assignment', () => {
    const bfs = makeBfsResult([['f_unassigned', 0.9]])
    const assignments: FileAssignment[] = []
    const result = aggregateComponents(bfs, assignments, [])
    expect(result).toHaveLength(0)
  })

  it('returns results sorted by weight descending', () => {
    const bfs = makeBfsResult([['f1', 0.3], ['f2', 0.7]])
    const assignments: FileAssignment[] = [
      { file_id: 'f1', component_id: 'comp1' },
      { file_id: 'f2', component_id: 'comp2' },
    ]
    const result = aggregateComponents(bfs, assignments, [])
    expect(result[0].weight).toBeGreaterThan(result[1].weight)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/lib/impact/component-aggregator.test.ts 2>&1 | head -10
```

Expected: FAIL with "Cannot find module '@/lib/impact/component-aggregator'"

- [ ] **Step 3: Implement component-aggregator.ts**

```typescript
// lib/impact/component-aggregator.ts
import type { FileBFSResult, FileAssignment, MappedComponent, ComponentWeight } from './types'

export function aggregateComponents(
  bfsResult: FileBFSResult,
  assignments: FileAssignment[],
  seedComponents: MappedComponent[]
): ComponentWeight[] {
  const weights = new Map<string, ComponentWeight>()

  // Seed components always win at weight 1.0
  for (const comp of seedComponents) {
    weights.set(comp.componentId, {
      componentId: comp.componentId,
      weight: 1.0,
      source: 'seed',
      sourceDetail: comp.matchReason,
    })
  }

  // File graph: file weight → component weight (take max)
  const fileToComponent = new Map<string, string>()
  for (const a of assignments) fileToComponent.set(a.file_id, a.component_id)

  for (const [fileId, fileWeight] of bfsResult.reachedFileIds) {
    const componentId = fileToComponent.get(fileId)
    if (!componentId) continue
    const existing = weights.get(componentId)
    if (!existing || fileWeight > existing.weight) {
      weights.set(componentId, {
        componentId,
        weight: fileWeight,
        source: 'file_graph',
        sourceDetail: fileId,
      })
    }
  }

  return Array.from(weights.values()).sort((a, b) => b.weight - a.weight)
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/lib/impact/component-aggregator.test.ts
```

Expected: 6 passing

- [ ] **Step 5: Commit**

```bash
git add lib/impact/component-aggregator.ts tests/lib/impact/component-aggregator.test.ts
git commit -m "feat: add component aggregator"
```

---

### Task 3: Risk Scorer

**Files:**
- Create: `lib/impact/risk-scorer.ts`
- Create: `tests/lib/impact/risk-scorer.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/lib/impact/risk-scorer.test.ts
import { describe, it, expect } from 'vitest'
import { computeRiskScore } from '@/lib/impact/risk-scorer'
import type { RiskFactors, ComponentWeight } from '@/lib/impact/types'

function baseFactors(overrides: Partial<RiskFactors> = {}): RiskFactors {
  return {
    blastRadius: 0,
    unknownDepsCount: 0,
    hasLowConfidenceComponents: false,
    componentTypes: [],
    dynamicImportCount: 0,
    ...overrides,
  }
}

function makeWeights(count: number, weight = 0.5): ComponentWeight[] {
  return Array.from({ length: count }, (_, i) => ({
    componentId: `c${i}`,
    weight,
    source: 'file_graph' as const,
    sourceDetail: `f${i}`,
  }))
}

describe('computeRiskScore', () => {
  it('returns low risk for empty analysis', () => {
    const result = computeRiskScore(baseFactors(), [])
    expect(result.riskLevel).toBe('low')
    expect(result.score).toBeLessThan(10)
  })

  it('blast radius above 0.3 threshold adds score', () => {
    const weights = makeWeights(5, 0.5) // all above 0.3
    const result = computeRiskScore(baseFactors({ blastRadius: 5 }), weights)
    expect(result.score).toBeGreaterThan(0)
    expect(result.confidenceBreakdown.blast_radius).toBeGreaterThan(0)
  })

  it('unknown deps increase score', () => {
    const r1 = computeRiskScore(baseFactors({ unknownDepsCount: 0 }), [])
    const r2 = computeRiskScore(baseFactors({ unknownDepsCount: 3 }), [])
    expect(r2.score).toBeGreaterThan(r1.score)
    expect(r2.confidenceBreakdown.unknown_deps).toBeGreaterThan(0)
  })

  it('low confidence components add score', () => {
    const r1 = computeRiskScore(baseFactors({ hasLowConfidenceComponents: false }), [])
    const r2 = computeRiskScore(baseFactors({ hasLowConfidenceComponents: true }), [])
    expect(r2.score).toBeGreaterThan(r1.score)
    expect(r2.confidenceBreakdown.low_confidence).toBeGreaterThan(0)
  })

  it('auth component type amplifies score', () => {
    const r1 = computeRiskScore(baseFactors({ componentTypes: ['service'] }), [])
    const r2 = computeRiskScore(baseFactors({ componentTypes: ['auth'] }), [])
    expect(r2.score).toBeGreaterThan(r1.score)
    expect(r2.confidenceBreakdown.auth_component).toBeGreaterThan(0)
  })

  it('database component type adds score', () => {
    const r1 = computeRiskScore(baseFactors(), [])
    const r2 = computeRiskScore(baseFactors({ componentTypes: ['database'] }), [])
    expect(r2.score).toBeGreaterThan(r1.score)
    expect(r2.confidenceBreakdown.data_component).toBeGreaterThan(0)
  })

  it('dynamic imports add score', () => {
    const r1 = computeRiskScore(baseFactors({ dynamicImportCount: 0 }), [])
    const r2 = computeRiskScore(baseFactors({ dynamicImportCount: 4 }), [])
    expect(r2.score).toBeGreaterThan(r1.score)
  })

  it('score >= 25 is high risk', () => {
    const weights = makeWeights(10, 0.5) // 10 components above 0.3
    const factors = baseFactors({
      blastRadius: 10,
      unknownDepsCount: 5,
      hasLowConfidenceComponents: true,
      componentTypes: ['auth', 'database'],
      dynamicImportCount: 5,
    })
    const result = computeRiskScore(factors, weights)
    expect(result.riskLevel).toBe('high')
    expect(result.score).toBeGreaterThanOrEqual(25)
  })

  it('10 <= score < 25 is medium risk', () => {
    const weights = makeWeights(4, 0.5)
    const factors = baseFactors({ blastRadius: 4 })
    const result = computeRiskScore(factors, weights)
    expect(result.score).toBeGreaterThanOrEqual(10)
    expect(result.score).toBeLessThan(25)
    expect(result.riskLevel).toBe('medium')
  })

  it('primaryRiskFactor is the highest-weighted breakdown entry', () => {
    const weights = makeWeights(5, 0.5)
    const factors = baseFactors({ blastRadius: 5, unknownDepsCount: 1 })
    const result = computeRiskScore(factors, weights)
    expect(result.primaryRiskFactor).toBe('blast_radius')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/lib/impact/risk-scorer.test.ts 2>&1 | head -10
```

Expected: FAIL with "Cannot find module '@/lib/impact/risk-scorer'"

- [ ] **Step 3: Implement risk-scorer.ts**

```typescript
// lib/impact/risk-scorer.ts
import type { RiskFactors, ComponentWeight, RiskScoreResult } from './types'

export function computeRiskScore(
  factors: RiskFactors,
  componentWeights: ComponentWeight[]
): RiskScoreResult {
  let score = 0
  const breakdown: Record<string, number> = {}

  // Blast radius: components with weight > 0.3 (capped at 15)
  const significantCount = componentWeights.filter(c => c.weight > 0.3).length
  if (significantCount > 0) {
    const s = Math.min(significantCount * 3, 15)
    score += s
    breakdown.blast_radius = s
  }

  // Unknown deps (capped at 8)
  if (factors.unknownDepsCount > 0) {
    const s = Math.min(factors.unknownDepsCount * 2, 8)
    score += s
    breakdown.unknown_deps = s
  }

  // Low confidence penalty
  if (factors.hasLowConfidenceComponents) {
    score += 4
    breakdown.low_confidence = 4
  }

  // Auth component amplifier
  if (factors.componentTypes.includes('auth')) {
    score += 5
    breakdown.auth_component = 5
  }

  // Data component amplifier
  if (factors.componentTypes.some(t => t === 'database' || t === 'repository')) {
    score += 3
    breakdown.data_component = 3
  }

  // Dynamic imports (capped at 5)
  if (factors.dynamicImportCount > 0) {
    const s = Math.min(factors.dynamicImportCount, 5)
    score += s
    breakdown.dynamic_imports = s
  }

  const riskLevel: RiskScoreResult['riskLevel'] = score < 10 ? 'low' : score < 25 ? 'medium' : 'high'
  const primaryRiskFactor =
    Object.entries(breakdown).sort(([, a], [, b]) => b - a)[0]?.[0] ?? 'none'

  return { score, riskLevel, primaryRiskFactor, confidenceBreakdown: breakdown }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/lib/impact/risk-scorer.test.ts
```

Expected: 10 passing

- [ ] **Step 5: Commit**

```bash
git add lib/impact/risk-scorer.ts tests/lib/impact/risk-scorer.test.ts
git commit -m "feat: add risk scorer"
```

---

### Task 4: Migration Detector

**Files:**
- Create: `lib/impact/migration-detector.ts`
- Create: `tests/lib/impact/migration-detector.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/lib/impact/migration-detector.test.ts
import { describe, it, expect, vi } from 'vitest'
import { detectMigrationRequirements, detectMigrationWithAIFallback } from '@/lib/impact/migration-detector'
import { MockAIProvider } from '@/lib/ai/adapters/mock'

describe('detectMigrationRequirements', () => {
  it('detects schema migration from multiple keyword matches', () => {
    const result = detectMigrationRequirements('Add a new column to the users table for last login')
    expect(result.requiresMigration).toBe(true)
    expect(result.confidence).toBe('high')
  })

  it('does not trigger on single keyword match', () => {
    const result = detectMigrationRequirements('Update the table component styling')
    expect(result.requiresMigration).toBe(false)
  })

  it('detects data migration from backfill keyword', () => {
    const result = detectMigrationRequirements('Backfill the new status field for all existing records')
    expect(result.requiresDataChange).toBe(true)
    expect(result.confidence).toBe('high')
  })

  it('returns low confidence with no matches', () => {
    const result = detectMigrationRequirements('Improve button hover animation')
    expect(result.requiresMigration).toBe(false)
    expect(result.requiresDataChange).toBe(false)
    expect(result.confidence).toBe('low')
  })

  it('detects rename column', () => {
    const result = detectMigrationRequirements('Rename the column email to email_address in users table')
    expect(result.requiresMigration).toBe(true)
  })
})

describe('detectMigrationWithAIFallback', () => {
  it('uses deterministic result when confidence is high', async () => {
    const ai = new MockAIProvider()
    const spy = vi.spyOn(ai, 'complete')
    const result = await detectMigrationWithAIFallback(
      'Add a column to the users table for last login',
      ['database'],
      ai
    )
    expect(result.requiresMigration).toBe(true)
    expect(spy).not.toHaveBeenCalled()
  })

  it('skips AI when no database component is involved', async () => {
    const ai = new MockAIProvider()
    const spy = vi.spyOn(ai, 'complete')
    const result = await detectMigrationWithAIFallback(
      'Improve button animation timing',
      ['ui', 'service'],
      ai
    )
    expect(result.requiresMigration).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })

  it('calls AI for ambiguous intent with database component', async () => {
    const ai = new MockAIProvider()
    ai.setResponse('requires_migration', JSON.stringify({ requires_migration: true, requires_data_change: false }))
    const result = await detectMigrationWithAIFallback(
      'Improve the user profile page performance',
      ['database'],
      ai
    )
    expect(ai.callCount).toBe(1)
    expect(result.requiresMigration).toBe(true)
    expect(result.requiresDataChange).toBe(false)
  })

  it('returns false if AI response cannot be parsed', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse('not valid json')
    const result = await detectMigrationWithAIFallback(
      'Do something with data',
      ['database'],
      ai
    )
    expect(result.requiresMigration).toBe(false)
    expect(result.requiresDataChange).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/lib/impact/migration-detector.test.ts 2>&1 | head -10
```

Expected: FAIL with "Cannot find module '@/lib/impact/migration-detector'"

- [ ] **Step 3: Implement migration-detector.ts**

```typescript
// lib/impact/migration-detector.ts
import type { AIProvider } from '@/lib/ai/provider'

const DB_MIGRATION_PATTERNS = [
  /\bschema\b/i,
  /\btable\b/i,
  /\bcolumn\b/i,
  /\bmigration\b/i,
  /\badd.*field\b/i,
  /\bremove.*field\b/i,
  /\brename.*column\b/i,
  /\bdrop.*table\b/i,
  /\bcreate.*table\b/i,
]

const DATA_CHANGE_PATTERNS = [
  /\bbackfill\b/i,
  /\bdata\s+migration\b/i,
  /\bexisting.*data\b/i,
  /\bupdate.*all.*records\b/i,
  /\bpopulate.*records\b/i,
]

export function detectMigrationRequirements(intent: string): {
  requiresMigration: boolean
  requiresDataChange: boolean
  confidence: 'high' | 'low'
} {
  const migrationMatches = DB_MIGRATION_PATTERNS.filter(p => p.test(intent)).length
  const dataMatches = DATA_CHANGE_PATTERNS.filter(p => p.test(intent)).length
  const requiresMigration = migrationMatches >= 2
  const requiresDataChange = dataMatches >= 1
  const confidence = (requiresMigration || requiresDataChange) ? 'high' : 'low'
  return { requiresMigration, requiresDataChange, confidence }
}

export async function detectMigrationWithAIFallback(
  intent: string,
  componentTypes: string[],
  ai: AIProvider
): Promise<{ requiresMigration: boolean; requiresDataChange: boolean }> {
  const deterministic = detectMigrationRequirements(intent)
  if (deterministic.confidence === 'high') {
    return {
      requiresMigration: deterministic.requiresMigration,
      requiresDataChange: deterministic.requiresDataChange,
    }
  }

  const hasDataComponent = componentTypes.some(t => t === 'database' || t === 'repository')
  if (!hasDataComponent) return { requiresMigration: false, requiresDataChange: false }

  const result = await ai.complete(
    `Does this software change require a database schema migration or data migration?\n\nIntent: ${intent}\n\nRespond with JSON: {"requires_migration": boolean, "requires_data_change": boolean}`,
    {
      responseSchema: {
        type: 'object',
        properties: {
          requires_migration: { type: 'boolean' },
          requires_data_change: { type: 'boolean' },
        },
        required: ['requires_migration', 'requires_data_change'],
      },
      maxTokens: 100,
    }
  )

  try {
    const parsed = JSON.parse(result.content)
    return {
      requiresMigration: !!parsed.requires_migration,
      requiresDataChange: !!parsed.requires_data_change,
    }
  } catch {
    return { requiresMigration: false, requiresDataChange: false }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/lib/impact/migration-detector.test.ts
```

Expected: 9 passing

- [ ] **Step 5: Commit**

```bash
git add lib/impact/migration-detector.ts tests/lib/impact/migration-detector.test.ts
git commit -m "feat: add migration detector"
```

---

### Task 5: Component Mapper

**Files:**
- Create: `lib/impact/component-mapper.ts`
- Create: `tests/lib/impact/component-mapper.test.ts`

- [ ] **Step 1: Write the failing tests**

The mapper performs DB reads in a specific sequence: fetch change → fetch components → fetch assignments → keyword match → AI call. Use a factory function to build a mock DB that models this query chain.

```typescript
// tests/lib/impact/component-mapper.test.ts
import { describe, it, expect } from 'vitest'
import { mapComponents } from '@/lib/impact/component-mapper'
import { MockAIProvider } from '@/lib/ai/adapters/mock'
import type { SupabaseClient } from '@supabase/supabase-js'

const COMPONENTS = [
  { id: 'comp-auth', name: 'AuthService', type: 'auth' },
  { id: 'comp-user', name: 'UserRepository', type: 'repository' },
  { id: 'comp-api', name: 'ProjectsAPI', type: 'api' },
]

const ASSIGNMENTS = [
  { file_id: 'file-auth-1', component_id: 'comp-auth' },
  { file_id: 'file-auth-2', component_id: 'comp-auth' },
  { file_id: 'file-user-1', component_id: 'comp-user' },
]

function makeMockDb(overrides: { components?: typeof COMPONENTS; assignments?: typeof ASSIGNMENTS } = {}): SupabaseClient {
  const components = overrides.components ?? COMPONENTS
  const assignments = overrides.assignments ?? ASSIGNMENTS

  return {
    from: (table: string) => {
      if (table === 'change_requests') {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: { project_id: 'proj1' }, error: null }),
            }),
          }),
        }
      }
      if (table === 'system_components') {
        return {
          select: () => ({
            eq: () => ({
              is: () => ({
                order: () => Promise.resolve({ data: components, error: null }),
              }),
            }),
          }),
        }
      }
      if (table === 'component_assignment') {
        return {
          select: () => ({
            in: () => Promise.resolve({ data: assignments, error: null }),
          }),
        }
      }
      return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null, error: null }) }) }) }
    },
  } as unknown as SupabaseClient
}

describe('mapComponents', () => {
  it('matches components by keyword in title', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({ affected: [] }))
    const result = await mapComponents(
      'cr1',
      { title: 'Fix auth login timeout', intent: 'The login is slow', tags: [] },
      makeMockDb(),
      ai
    )
    expect(result.components.some(c => c.componentId === 'comp-auth')).toBe(true)
    const authComp = result.components.find(c => c.componentId === 'comp-auth')!
    expect(authComp.matchReason).toContain('keyword')
  })

  it('matches components by tag', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({ affected: [] }))
    const result = await mapComponents(
      'cr1',
      { title: 'Improve performance', intent: 'Too slow', tags: ['auth'] },
      makeMockDb(),
      ai
    )
    expect(result.components.some(c => c.componentId === 'comp-auth')).toBe(true)
  })

  it('uses AI to find components not matched by keyword', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({ affected: ['ProjectsAPI'] }))
    const result = await mapComponents(
      'cr1',
      { title: 'Improve project listing speed', intent: 'Slow', tags: [] },
      makeMockDb(),
      ai
    )
    expect(result.aiUsed).toBe(true)
    expect(result.components.some(c => c.componentId === 'comp-api')).toBe(true)
  })

  it('does not duplicate components from keyword and AI', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({ affected: ['AuthService'] }))
    const result = await mapComponents(
      'cr1',
      { title: 'Fix auth login', intent: 'Auth is broken', tags: [] },
      makeMockDb(),
      ai
    )
    const authMatches = result.components.filter(c => c.componentId === 'comp-auth')
    expect(authMatches).toHaveLength(1)
  })

  it('returns seed file IDs from component assignments', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({ affected: [] }))
    const result = await mapComponents(
      'cr1',
      { title: 'Fix auth login', intent: 'Auth broken', tags: [] },
      makeMockDb(),
      ai
    )
    expect(result.seedFileIds).toContain('file-auth-1')
    expect(result.seedFileIds).toContain('file-auth-2')
  })

  it('handles empty component list gracefully', async () => {
    const ai = new MockAIProvider()
    const result = await mapComponents(
      'cr1',
      { title: 'Anything', intent: 'Whatever', tags: [] },
      makeMockDb({ components: [] }),
      ai
    )
    expect(result.components).toHaveLength(0)
    expect(result.seedFileIds).toHaveLength(0)
    expect(result.aiUsed).toBe(false)
    expect(ai.callCount).toBe(0)
  })

  it('handles malformed AI JSON gracefully', async () => {
    const ai = new MockAIProvider()
    ai.setDefaultResponse('not valid json')
    const result = await mapComponents(
      'cr1',
      { title: 'Some change', intent: 'Something', tags: [] },
      makeMockDb(),
      ai
    )
    // Should not throw — AI errors are swallowed
    expect(result).toBeDefined()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/lib/impact/component-mapper.test.ts 2>&1 | head -10
```

Expected: FAIL with "Cannot find module '@/lib/impact/component-mapper'"

- [ ] **Step 3: Implement component-mapper.ts**

```typescript
// lib/impact/component-mapper.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIProvider } from '@/lib/ai/provider'
import type { MappedComponent, ComponentMapResult } from './types'

export async function mapComponents(
  changeId: string,
  change: { title: string; intent: string; tags: string[] },
  db: SupabaseClient,
  ai: AIProvider
): Promise<ComponentMapResult> {
  // 1. Get project_id for this change
  const { data: changeRow } = await db
    .from('change_requests')
    .select('project_id')
    .eq('id', changeId)
    .single()

  const projectId = changeRow?.project_id
  if (!projectId) return { seedFileIds: [], components: [], aiUsed: false }

  // 2. Fetch all components for project
  const { data: components } = await db
    .from('system_components')
    .select('id, name, type')
    .eq('project_id', projectId)
    .is('deleted_at', null)
    .order('name' as any)

  if (!components?.length) return { seedFileIds: [], components: [], aiUsed: false }

  // 3. Keyword match: title words + tags → component names
  const searchTerms = [
    ...change.title.toLowerCase().split(/\s+/),
    ...change.tags.map(t => t.toLowerCase()),
  ].filter(t => t.length > 2)

  const mappedComponents: MappedComponent[] = []
  const matchedIds = new Set<string>()

  for (const comp of components) {
    const nameLower = comp.name.toLowerCase()
    const hits = searchTerms.filter(term => nameLower.includes(term))
    if (hits.length > 0) {
      matchedIds.add(comp.id)
      mappedComponents.push({
        componentId: comp.id,
        name: comp.name,
        type: comp.type,
        confidence: Math.min(50 + hits.length * 15, 90),
        matchReason: `keyword: ${hits.join(', ')}`,
      })
    }
  }

  // 4. AI mapping for components not caught by keyword match
  let aiUsed = false
  try {
    const componentList = components.map(c => c.name).join('\n')
    const result = await ai.complete(
      `Given this software change, identify which system components are likely affected.\n\nChange title: ${change.title}\nIntent: ${change.intent}\n\nAvailable components:\n${componentList}\n\nRespond with JSON: {"affected": ["ComponentName1"]}`,
      {
        responseSchema: {
          type: 'object',
          properties: { affected: { type: 'array', items: { type: 'string' } } },
          required: ['affected'],
        },
        maxTokens: 500,
      }
    )
    const parsed = JSON.parse(result.content)
    for (const name of parsed.affected ?? []) {
      const comp = components.find(c => c.name === name)
      if (comp && !matchedIds.has(comp.id)) {
        matchedIds.add(comp.id)
        mappedComponents.push({
          componentId: comp.id,
          name: comp.name,
          type: comp.type,
          confidence: 70,
          matchReason: 'ai_mapping',
        })
        aiUsed = true
      }
    }
  } catch {
    // AI errors are non-fatal
  }

  // 5. Fetch file IDs for all matched components to use as seeds
  const { data: assignments } = await db
    .from('component_assignment')
    .select('file_id, component_id')
    .in('component_id', Array.from(matchedIds))

  const seedFileIds = (assignments ?? [])
    .map(a => a.file_id)
    .filter(Boolean)
    .slice(0, 30)

  return { seedFileIds, components: mappedComponents, aiUsed }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/lib/impact/component-mapper.test.ts
```

Expected: 7 passing

- [ ] **Step 5: Commit**

```bash
git add lib/impact/component-mapper.ts tests/lib/impact/component-mapper.test.ts
git commit -m "feat: add component mapper"
```

---

### Task 6: Impact Analyzer Orchestrator

**Files:**
- Create: `lib/impact/impact-analyzer.ts`
- Create: `tests/lib/impact/impact-analyzer.test.ts`

- [ ] **Step 1: Write the failing tests**

The orchestrator touches many DB tables. Build a layered mock DB factory that returns a chain for each table. Focus on verifying status transitions, correct DB writes, and error handling.

```typescript
// tests/lib/impact/impact-analyzer.test.ts
import { describe, it, expect, vi } from 'vitest'
import { runImpactAnalysis } from '@/lib/impact/impact-analyzer'
import { MockAIProvider } from '@/lib/ai/adapters/mock'
import type { SupabaseClient } from '@supabase/supabase-js'

type UpdateCapture = { table: string; data: Record<string, unknown>; eq: string }
type InsertCapture = { table: string; data: Record<string, unknown> | Array<Record<string, unknown>> }

function makeMockDb(opts: {
  change?: Record<string, unknown>
  components?: Array<{ id: string; name: string; type: string; has_unknown_dependencies: boolean; avg_confidence: number }>
  edges?: Array<{ from_file_id: string; to_file_id: string; edge_type: string }>
  assignments?: Array<{ file_id: string; component_id: string }>
} = {}): { db: SupabaseClient; updates: UpdateCapture[]; inserts: InsertCapture[] } {
  const updates: UpdateCapture[] = []
  const inserts: InsertCapture[] = []

  const change = opts.change ?? {
    id: 'cr1', project_id: 'proj1', title: 'Fix auth', intent: 'Auth is broken', tags: []
  }
  const components = opts.components ?? [
    { id: 'comp-auth', name: 'AuthService', type: 'auth', has_unknown_dependencies: false, avg_confidence: 80 }
  ]
  const edges = opts.edges ?? []
  const assignments = opts.assignments ?? [
    { file_id: 'file-auth-1', component_id: 'comp-auth' }
  ]

  const db = {
    from: (table: string) => {
      if (table === 'change_requests') {
        return {
          update: (data: Record<string, unknown>) => ({
            eq: (col: string, val: string) => {
              updates.push({ table, data, eq: `${col}=${val}` })
              return Promise.resolve({ error: null })
            },
          }),
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: change, error: null }),
            }),
          }),
        }
      }
      if (table === 'system_components') {
        return {
          select: () => ({
            eq: () => ({
              is: () => ({
                order: () => Promise.resolve({ data: components, error: null }),
              }),
            }),
          }),
          // For the in() query to get component details by IDs
          _selectWithIn: () => ({
            in: () => Promise.resolve({ data: components, error: null }),
          }),
        }
      }
      if (table === 'component_graph_edges') {
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: edges, error: null }),
          }),
        }
      }
      if (table === 'component_assignment') {
        return {
          select: () => ({
            eq: () => Promise.resolve({ data: assignments, error: null }),
            in: () => Promise.resolve({ data: assignments, error: null }),
          }),
        }
      }
      if (table === 'change_impacts') {
        return {
          insert: (data: Record<string, unknown>) => ({
            select: () => ({
              single: () => {
                inserts.push({ table, data })
                return Promise.resolve({ data: { id: 'impact-1' }, error: null })
              },
            }),
          }),
        }
      }
      if (table === 'change_risk_factors') {
        return {
          insert: (data: unknown) => {
            inserts.push({ table, data: data as Record<string, unknown> })
            return Promise.resolve({ error: null })
          },
        }
      }
      if (table === 'change_impact_components') {
        return {
          insert: (data: unknown) => {
            inserts.push({ table, data: data as Array<Record<string, unknown>> })
            return Promise.resolve({ error: null })
          },
        }
      }
      return {
        select: () => ({ eq: () => ({ in: () => Promise.resolve({ data: [], error: null }), single: () => Promise.resolve({ data: null, error: null }) }) }),
        update: (data: Record<string, unknown>) => ({ eq: (col: string, val: string) => { updates.push({ table, data, eq: `${col}=${val}` }); return Promise.resolve({ error: null }) } }),
        insert: (data: unknown) => { inserts.push({ table, data: data as Record<string, unknown> }); return Promise.resolve({ error: null }) },
      }
    },
  } as unknown as SupabaseClient

  // Patch system_components to handle .in() chain
  const originalFrom = db.from.bind(db)
  ;(db as any).from = (table: string) => {
    const base = originalFrom(table)
    if (table === 'system_components') {
      return {
        ...base,
        select: (cols: string) => {
          const chain = (base as any).select(cols)
          return {
            ...chain,
            in: () => Promise.resolve({ data: components, error: null }),
            eq: chain.eq,
          }
        },
      }
    }
    return base
  }

  return { db, updates, inserts }
}

describe('runImpactAnalysis', () => {
  it('transitions through all analyzing statuses then analyzed', async () => {
    const { db, updates } = makeMockDb()
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({ affected: [] }))

    await runImpactAnalysis('cr1', db, ai)

    const statusUpdates = updates
      .filter(u => u.table === 'change_requests' && u.data.status)
      .map(u => u.data.status)

    expect(statusUpdates).toContain('analyzing_mapping')
    expect(statusUpdates).toContain('analyzing_propagation')
    expect(statusUpdates).toContain('analyzing_scoring')
    expect(statusUpdates).toContain('analyzed')
  })

  it('inserts a change_impacts row', async () => {
    const { db, inserts } = makeMockDb()
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({ affected: [] }))

    await runImpactAnalysis('cr1', db, ai)

    expect(inserts.some(i => i.table === 'change_impacts')).toBe(true)
  })

  it('inserts change_impact_components for mapped components', async () => {
    const { db, inserts } = makeMockDb()
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({ affected: [] }))

    await runImpactAnalysis('cr1', db, ai)

    expect(inserts.some(i => i.table === 'change_impact_components')).toBe(true)
  })

  it('sets status back to open on failure', async () => {
    // Make change_requests select fail after status update
    const { db, updates } = makeMockDb({ change: null as any })
    const ai = new MockAIProvider()

    // change is null → should throw inside and recover
    try {
      await runImpactAnalysis('cr1', db, ai)
    } catch {
      // expected
    }

    const finalStatus = updates
      .filter(u => u.table === 'change_requests')
      .map(u => u.data.status)
      .at(-1)

    expect(finalStatus).toBe('open')
  })

  it('sets risk_level on the change_request after analysis', async () => {
    const { db, updates } = makeMockDb()
    const ai = new MockAIProvider()
    ai.setDefaultResponse(JSON.stringify({ affected: [] }))

    await runImpactAnalysis('cr1', db, ai)

    const finalUpdate = updates
      .filter(u => u.table === 'change_requests' && u.data.risk_level)
      .at(-1)

    expect(['low', 'medium', 'high']).toContain(finalUpdate?.data.risk_level)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/lib/impact/impact-analyzer.test.ts 2>&1 | head -10
```

Expected: FAIL with "Cannot find module '@/lib/impact/impact-analyzer'"

- [ ] **Step 3: Implement impact-analyzer.ts**

```typescript
// lib/impact/impact-analyzer.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AIProvider } from '@/lib/ai/provider'
import type { RiskFactors } from './types'
import { mapComponents } from './component-mapper'
import { runFileBFS } from './file-bfs'
import { aggregateComponents } from './component-aggregator'
import { computeRiskScore } from './risk-scorer'
import { detectMigrationWithAIFallback } from './migration-detector'

export async function runImpactAnalysis(
  changeId: string,
  db: SupabaseClient,
  ai: AIProvider
): Promise<void> {
  await db.from('change_requests').update({ status: 'analyzing_mapping' }).eq('id', changeId)

  try {
    // Load change
    const { data: change } = await db
      .from('change_requests')
      .select('id, project_id, title, intent, tags')
      .eq('id', changeId)
      .single()

    if (!change) throw new Error(`Change not found: ${changeId}`)

    // Phase 1: Component Mapping
    const mapResult = await mapComponents(changeId, change, db, ai)

    await db.from('change_requests').update({ status: 'analyzing_propagation' }).eq('id', changeId)

    // Phase 2a: Fetch file-level edges + assignments
    const { data: edges } = await db
      .from('component_graph_edges')
      .select('from_file_id, to_file_id, edge_type')
      .eq('project_id', change.project_id)

    const { data: assignments } = await db
      .from('component_assignment')
      .select('file_id, component_id')
      .eq('project_id', change.project_id)

    // Phase 2b: File BFS
    const seeds = mapResult.seedFileIds.map(fileId => ({ fileId, reason: 'component_match' as const }))
    const bfsResult = runFileBFS(seeds, edges ?? [])

    // Phase 2c: Aggregate to components
    const componentWeights = aggregateComponents(bfsResult, assignments ?? [], mapResult.components)

    // Fetch component details for risk scoring
    const componentIds = componentWeights.map(c => c.componentId)
    const { data: componentDetails } = componentIds.length > 0
      ? await (db.from('system_components') as any)
          .select('id, name, type, has_unknown_dependencies, avg_confidence')
          .in('id', componentIds)
      : { data: [] }

    await db.from('change_requests').update({ status: 'analyzing_scoring' }).eq('id', changeId)

    // Phase 3: Risk Scoring
    const types = (componentDetails ?? []).map((c: any) => c.type as string)
    const riskFactors: RiskFactors = {
      blastRadius: componentWeights.filter(c => c.weight > 0.3).length,
      unknownDepsCount: (componentDetails ?? []).filter((c: any) => c.has_unknown_dependencies).length,
      hasLowConfidenceComponents: (componentDetails ?? []).some((c: any) => (c.avg_confidence ?? 100) < 60),
      componentTypes: types,
      dynamicImportCount: Object.values(bfsResult.dynamicImportCounts).reduce((a, b) => a + b, 0),
    }
    const riskResult = computeRiskScore(riskFactors, componentWeights)

    // Phase 4: Migration Detection
    const migrationResult = await detectMigrationWithAIFallback(change.intent, types, ai)

    // Write change_impacts
    const { data: impact } = await db
      .from('change_impacts')
      .insert({
        change_id: changeId,
        project_id: change.project_id,
        risk_score: riskResult.score,
        blast_radius: riskFactors.blastRadius,
        primary_risk_factor: riskResult.primaryRiskFactor,
        analysis_quality: mapResult.aiUsed ? 'ai_assisted' : 'heuristic',
        requires_migration: migrationResult.requiresMigration,
        requires_data_change: migrationResult.requiresDataChange,
      })
      .select('id')
      .single()

    if (!impact) throw new Error('Failed to insert change_impacts')

    // Write risk factors
    const riskFactorRows = Object.entries(riskResult.confidenceBreakdown).map(([factor, weight]) => ({
      change_id: changeId,
      impact_id: impact.id,
      factor,
      weight,
    }))
    if (riskFactorRows.length > 0) {
      await db.from('change_risk_factors').insert(riskFactorRows)
    }

    // Write impact components (top 20)
    const componentRows = componentWeights.slice(0, 20).map(c => ({
      impact_id: impact.id,
      change_id: changeId,
      component_id: c.componentId,
      impact_weight: c.weight,
      source: c.source,
      source_detail: c.sourceDetail,
    }))
    if (componentRows.length > 0) {
      await db.from('change_impact_components').insert(componentRows)
    }

    // Final status update
    const unknownRatio = componentWeights.length > 0
      ? riskFactors.unknownDepsCount / componentWeights.length
      : 0
    const confidence_score = Math.max(Math.round(100 - unknownRatio * 40 - (mapResult.aiUsed ? 10 : 0)), 20)

    await db.from('change_requests').update({
      status: 'analyzed',
      risk_level: riskResult.riskLevel,
      confidence_score,
      confidence_breakdown: riskResult.confidenceBreakdown,
      analysis_quality: mapResult.aiUsed ? 'ai_assisted' : 'heuristic',
    }).eq('id', changeId)

  } catch (err) {
    await db.from('change_requests').update({ status: 'open' }).eq('id', changeId)
    throw err
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/lib/impact/impact-analyzer.test.ts
```

Expected: 5 passing

- [ ] **Step 5: Run the full impact test suite**

```bash
npx vitest run tests/lib/impact/
```

Expected: all passing (file-bfs + component-aggregator + risk-scorer + migration-detector + component-mapper + impact-analyzer)

- [ ] **Step 6: Commit**

```bash
git add lib/impact/impact-analyzer.ts tests/lib/impact/impact-analyzer.test.ts
git commit -m "feat: add impact analyzer orchestrator"
```

---

### Task 7: API Endpoints

**Files:**
- Create: `app/api/change-requests/[id]/analyze/route.ts`
- Modify: `app/api/change-requests/route.ts`

Read both files before editing.

- [ ] **Step 1: Read existing files**

```bash
# Read these files before making changes:
# app/api/change-requests/route.ts
# app/api/projects/[id]/scan/route.ts   ← reference: fire-and-forget pattern
```

- [ ] **Step 2: Write the analyze route**

Create `app/api/change-requests/[id]/analyze/route.ts`:

```typescript
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getProvider } from '@/lib/ai/registry'
import { runImpactAnalysis } from '@/lib/impact/impact-analyzer'

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Verify ownership via project
  const { data: change } = await db
    .from('change_requests')
    .select('id, status, projects!inner(owner_id)')
    .eq('id', id)
    .eq('projects.owner_id', user.id)
    .single()

  if (!change) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Prevent re-triggering an in-progress analysis
  const ANALYZING = ['analyzing', 'analyzing_mapping', 'analyzing_propagation', 'analyzing_scoring']
  if (ANALYZING.includes(change.status)) {
    return NextResponse.json({ error: 'Analysis already in progress' }, { status: 409 })
  }

  // Fire-and-forget
  const adminDb = createAdminClient()
  const ai = getProvider()
  runImpactAnalysis(id, adminDb, ai).catch(err =>
    console.error(`[impact-analyzer] change ${id} failed:`, err)
  )

  return NextResponse.json({ status: 'analyzing' }, { status: 202 })
}
```

- [ ] **Step 3: Modify change-requests POST to auto-trigger**

In `app/api/change-requests/route.ts`, add these imports at the top and modify the response:

```typescript
// Add to existing imports:
import { createAdminClient } from '@/lib/supabase/admin'
import { getProvider } from '@/lib/ai/registry'
import { runImpactAnalysis } from '@/lib/impact/impact-analyzer'
```

Replace the final return in the POST handler:

```typescript
  // Before: return NextResponse.json(change, { status: 201 })
  // After:

  // Auto-trigger impact analysis fire-and-forget
  const adminDb = createAdminClient()
  const ai = getProvider()
  runImpactAnalysis(change.id, adminDb, ai).catch(err =>
    console.error(`[impact-analyzer] change ${change.id} failed:`, err)
  )

  return NextResponse.json(change, { status: 201 })
```

- [ ] **Step 4: Run full test suite to verify nothing broke**

```bash
npx vitest run
```

Expected: all tests passing

- [ ] **Step 5: Commit**

```bash
git add app/api/change-requests/route.ts app/api/change-requests/[id]/analyze/route.ts
git commit -m "feat: add analyze endpoint, auto-trigger impact analysis on change creation"
```

---

### Task 8: UI — Full Impact Panel

**Files:**
- Modify: `app/projects/[id]/changes/[changeId]/page.tsx`
- Modify: `app/projects/[id]/changes/[changeId]/change-detail-view.tsx`

Read both files before editing.

- [ ] **Step 1: Read existing files**

Read both files in full before making any changes. Look at: what the server page currently fetches, what the `Change` interface looks like in the view, and the existing analysis state sections.

- [ ] **Step 2: Update the server page to fetch impact data**

In `app/projects/[id]/changes/[changeId]/page.tsx`, after the `change` query, add impact fetching and pass to the view:

```typescript
// After the change query, before the return:

  // Fetch impact if analyzed
  const { data: impact } = await db
    .from('change_impacts')
    .select('id, risk_score, blast_radius, primary_risk_factor, analysis_quality, requires_migration, requires_data_change')
    .eq('change_id', changeId)
    .maybeSingle()

  const { data: riskFactors } = impact
    ? await db
        .from('change_risk_factors')
        .select('factor, weight')
        .eq('change_id', changeId)
        .order('weight', { ascending: false })
    : { data: [] }

  const { data: impactComponents } = impact
    ? await db
        .from('change_impact_components')
        .select('component_id, impact_weight, source, system_components(name, type)')
        .eq('impact_id', impact.id)
        .order('impact_weight', { ascending: false })
        .limit(10)
    : { data: [] }

  return (
    <ChangeDetailView
      project={project}
      change={change}
      impact={impact ?? null}
      riskFactors={riskFactors ?? []}
      impactComponents={impactComponents ?? []}
    />
  )
```

- [ ] **Step 3: Update ChangeDetailView — interfaces and props**

At the top of `change-detail-view.tsx`, add these interfaces and update the function signature:

```typescript
interface ImpactData {
  id: string
  risk_score: number | null
  blast_radius: number | null
  primary_risk_factor: string | null
  analysis_quality: string | null
  requires_migration: boolean | null
  requires_data_change: boolean | null
}

interface RiskFactor {
  factor: string
  weight: number
}

interface ImpactComponent {
  component_id: string
  impact_weight: number
  source: string
  system_components: { name: string; type: string } | null
}

// Update function signature:
export function ChangeDetailView({
  project,
  change: initial,
  impact: initialImpact,
  riskFactors: initialRiskFactors,
  impactComponents: initialImpactComponents,
}: {
  project: Project
  change: Change
  impact: ImpactData | null
  riskFactors: RiskFactor[]
  impactComponents: ImpactComponent[]
})
```

- [ ] **Step 4: Add state and polling for impact data**

Inside `ChangeDetailView`, after the `change` state, add:

```typescript
  const [impact, setImpact] = useState(initialImpact)
  const [riskFactors, setRiskFactors] = useState(initialRiskFactors)
  const [impactComponents, setImpactComponents] = useState(initialImpactComponents)
```

Update the polling `useEffect` to also update impact data when analysis completes:

```typescript
  useEffect(() => {
    if (!isAnalyzing) return
    const id = setInterval(async () => {
      const res = await fetch(`/api/change-requests/${change.id}`)
      if (!res.ok) return
      const updated = await res.json()
      setChange(updated)
      if (!ANALYZING_STATUSES.includes(updated.status)) {
        clearInterval(id)
        setImpact(updated.impact ?? null)
        setRiskFactors(updated.risk_factors ?? [])
        setImpactComponents(updated.impact_components ?? [])
        router.refresh()
      }
    }, 2000)
    return () => clearInterval(id)
  }, [change.id, isAnalyzing, router])
```

- [ ] **Step 5: Replace the analyzed stub with the full impact panel**

Find this section in the JSX:

```typescript
            ) : change.status === 'analyzed' ? (
              <div className="rounded-xl p-6 bg-[#131b2e] border border-white/5">
                <p className="text-xs font-bold uppercase tracking-widest text-slate-400 font-headline mb-2">Impact Analysis</p>
                <p className="text-sm text-slate-400">Analysis complete. Full impact panel coming in Plan 4.</p>
                {change.confidence_score !== null && (
                  <p className="text-xs text-slate-500 mt-1 font-mono">Confidence: {change.confidence_score}%</p>
                )}
              </div>
```

Replace with:

```typescript
            ) : change.status === 'analyzed' && impact ? (
              <div className="rounded-xl bg-[#131b2e] border border-white/5 overflow-hidden">
                {/* Header row */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
                  <p className="text-xs font-bold uppercase tracking-widest text-slate-400 font-headline">Impact Analysis</p>
                  <div className="flex items-center gap-2">
                    {change.confidence_score !== null && (
                      <span className="text-[10px] font-mono text-slate-500">{change.confidence_score}% confidence</span>
                    )}
                    {impact.analysis_quality && (
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-700 text-slate-400 uppercase tracking-wider">
                        {impact.analysis_quality.replace('_', ' ')}
                      </span>
                    )}
                  </div>
                </div>

                {/* Risk score + blast radius */}
                <div className="grid grid-cols-3 divide-x divide-white/5 border-b border-white/5">
                  <div className="px-5 py-4">
                    <p className="text-[10px] uppercase tracking-widest text-slate-500 font-headline mb-1">Risk Level</p>
                    <p className={`text-lg font-extrabold font-headline capitalize ${
                      change.risk_level === 'high' ? 'text-red-400' :
                      change.risk_level === 'medium' ? 'text-amber-400' : 'text-green-400'
                    }`}>{change.risk_level ?? '—'}</p>
                  </div>
                  <div className="px-5 py-4">
                    <p className="text-[10px] uppercase tracking-widest text-slate-500 font-headline mb-1">Risk Score</p>
                    <p className="text-lg font-extrabold font-headline text-on-surface font-mono">{impact.risk_score ?? '—'}</p>
                  </div>
                  <div className="px-5 py-4">
                    <p className="text-[10px] uppercase tracking-widest text-slate-500 font-headline mb-1">Blast Radius</p>
                    <p className="text-lg font-extrabold font-headline text-on-surface font-mono">
                      {impact.blast_radius ?? '—'}
                      <span className="text-xs font-normal text-slate-500 ml-1">components</span>
                    </p>
                  </div>
                </div>

                {/* Migration flags */}
                {(impact.requires_migration || impact.requires_data_change) && (
                  <div className="px-5 py-3 border-b border-white/5 flex items-center gap-3 flex-wrap">
                    {impact.requires_migration && (
                      <span className="flex items-center gap-1.5 text-xs text-amber-300 font-mono">
                        <span className="material-symbols-outlined text-amber-400" style={{ fontSize: '14px' }}>warning</span>
                        Schema migration required
                      </span>
                    )}
                    {impact.requires_data_change && (
                      <span className="flex items-center gap-1.5 text-xs text-orange-300 font-mono">
                        <span className="material-symbols-outlined text-orange-400" style={{ fontSize: '14px' }}>database</span>
                        Data migration required
                      </span>
                    )}
                  </div>
                )}

                {/* Affected components */}
                {impactComponents.length > 0 && (
                  <div className="px-5 py-4 border-b border-white/5">
                    <p className="text-[10px] uppercase tracking-widest text-slate-500 font-headline mb-3">Affected Components</p>
                    <div className="space-y-2">
                      {impactComponents.map((ic) => (
                        <div key={ic.component_id} className="flex items-center justify-between">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-[10px] font-mono px-1 py-0.5 rounded bg-indigo-400/10 text-indigo-300 uppercase flex-shrink-0">
                              {ic.system_components?.type ?? '?'}
                            </span>
                            <span className="text-sm text-slate-300 font-mono truncate">
                              {ic.system_components?.name ?? ic.component_id}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            <div
                              className="h-1.5 rounded-full bg-indigo-500/40"
                              style={{ width: `${Math.round(ic.impact_weight * 60 + 12)}px` }}
                            />
                            <span className="text-[10px] font-mono text-slate-500 w-8 text-right">
                              {Math.round(ic.impact_weight * 100)}%
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Risk factors */}
                {riskFactors.length > 0 && (
                  <div className="px-5 py-4">
                    <p className="text-[10px] uppercase tracking-widest text-slate-500 font-headline mb-3">Risk Factors</p>
                    <div className="space-y-1.5">
                      {riskFactors.map((rf) => (
                        <div key={rf.factor} className="flex items-center justify-between">
                          <span className="text-xs text-slate-400 font-mono capitalize">{rf.factor.replace(/_/g, ' ')}</span>
                          <span className="text-xs font-mono text-slate-500">+{rf.weight}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
```

Also handle the edge case where status is 'analyzed' but impact is null (analysis failed to write):

After the closing `>` of the analyzed panel, add:

```typescript
            ) : change.status === 'analyzed' && !impact ? (
              <div className="rounded-xl p-6 bg-[#131b2e] border border-white/5 text-center">
                <p className="text-sm text-slate-500">Analysis complete but impact data unavailable.</p>
              </div>
```

- [ ] **Step 6: Add Trigger Analysis button for 'open' status**

Find the open status section:

```typescript
            ) : change.status === 'open' ? (
              <div className="rounded-xl p-6 bg-[#131b2e] border border-white/5 text-center">
                <span className="material-symbols-outlined text-slate-600 mb-2 block" style={{ fontSize: '28px' }}>analytics</span>
                <p className="text-sm text-slate-500">Impact analysis will run when triggered.</p>
                <p className="text-xs text-slate-600 mt-1">Analysis engine coming in a future update.</p>
              </div>
```

Replace with:

```typescript
            ) : change.status === 'open' ? (
              <div className="rounded-xl p-6 bg-[#131b2e] border border-white/5 text-center">
                <span className="material-symbols-outlined text-slate-600 mb-3 block" style={{ fontSize: '28px' }}>analytics</span>
                <p className="text-sm text-slate-400 mb-4">Run impact analysis to see which components this change affects.</p>
                <button
                  onClick={async () => {
                    const res = await fetch(`/api/change-requests/${change.id}/analyze`, { method: 'POST' })
                    if (res.ok) {
                      setChange(c => ({ ...c, status: 'analyzing_mapping' }))
                    }
                  }}
                  className="px-4 py-2 rounded-lg bg-indigo-500 hover:bg-indigo-400 text-white text-sm font-bold font-headline transition-colors"
                >
                  Run Analysis
                </button>
              </div>
```

- [ ] **Step 7: Run full test suite to verify nothing broke**

```bash
npx vitest run
```

Expected: all tests passing

- [ ] **Step 8: Commit**

```bash
git add app/projects/[id]/changes/[changeId]/page.tsx app/projects/[id]/changes/[changeId]/change-detail-view.tsx
git commit -m "feat: add full impact panel to change detail view"
```

---

## Self-Review

### Spec coverage

| Requirement | Covered by |
|-------------|-----------|
| 4-phase async pipeline | Task 6 (impact-analyzer.ts) |
| Component mapping (AI + keyword) | Task 5 (component-mapper.ts) |
| File BFS with edge-type decay | Task 1 (file-bfs.ts) |
| Component aggregation | Task 2 (component-aggregator.ts) |
| Risk scoring | Task 3 (risk-scorer.ts) |
| Migration detection (regex + AI fallback) | Task 4 (migration-detector.ts) |
| Status transitions during analysis | Task 6 tests verify all statuses |
| Write change_impacts | Task 6 (impact-analyzer.ts) |
| Write change_risk_factors | Task 6 (impact-analyzer.ts) |
| Write change_impact_components | Task 6 (impact-analyzer.ts) |
| POST /analyze trigger/retry endpoint | Task 7 |
| Auto-trigger on change creation | Task 7 |
| Full impact panel UI | Task 8 |
| Trigger Analysis button for open status | Task 8 |
| Error recovery (revert to open on failure) | Task 6 (catch block) |

### Type consistency check

- `SeedFile.fileId` — used in Task 1 (types.ts), Task 1 (file-bfs.ts tests), Task 5 (component-mapper.ts), Task 6 (impact-analyzer.ts) ✓
- `FileBFSResult.reachedFileIds` — Map<string, number>, consistent in Tasks 1, 2, 6 ✓
- `ComponentWeight.source: ImpactSource` — `'seed' | 'file_graph'`, matches DB column values ✓
- `RiskScoreResult.confidenceBreakdown` — `Record<string, number>`, matches `change_requests.confidence_breakdown` (jsonb) ✓
- `detectMigrationWithAIFallback` signature — `(intent, componentTypes, ai)` — called correctly in Task 6 ✓
- `mapComponents` returns `ComponentMapResult` with `seedFileIds: string[]` (not paths, file IDs) — consumed correctly in Task 6 ✓
- DB table names: `component_assignment` (not `component_file_assignments`) — consistent Tasks 5, 6 ✓
- DB table `component_graph_edges` columns: `from_file_id`, `to_file_id`, `edge_type` — consistent Tasks 1, 6 ✓
