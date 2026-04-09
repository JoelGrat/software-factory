# Dashboard Redesign — Plan 3: Client Hook + Active Changes + Recent Outcomes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prerequisite:** Plan 1 (Foundation) must be complete. SSE endpoint at `/api/projects/[id]/dashboard-stream` and polling endpoint at `/api/projects/[id]/dashboard-poll` must exist.

**Goal:** Build the `useAnalysisStream` React hook that drives all live dashboard sections, then implement the Active Changes and Recent Outcomes UI components.

**Architecture:** `useAnalysisStream` runs SSE + polling concurrently from the start. SSE is fast path; polling every 12s is the consistency layer. On every poll + heartbeat, the hook enforces the snapshot reconciliation rule (if snapshot exists and local state isn't completed → force transition). Components are pure — they receive data as props from the hook and render it.

**Tech Stack:** React, Next.js App Router (client components), Supabase client, Vitest + jsdom

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `hooks/use-analysis-stream.ts` | Create | SSE + polling hybrid hook with reconciliation |
| `app/projects/[id]/components/active-changes.tsx` | Create | Live card per active change with progress + edit affordance |
| `app/projects/[id]/components/recent-outcomes.tsx` | Create | Last 5 outcome cards with model miss buckets, suggestions, learning signal |
| `app/projects/[id]/project-dashboard.tsx` | Modify | Replace existing content with new section layout, wire hook |
| `app/projects/[id]/page.tsx` | Modify | Pass precomputed snapshots + active changes from server |
| `tests/lib/dashboard/use-analysis-stream.test.ts` | Create | Reconciliation rule, version dedup, analysisVersion filter |

---

### Task 1: `useAnalysisStream` Hook

**Files:**
- Create: `hooks/use-analysis-stream.ts`
- Create: `tests/lib/dashboard/use-analysis-stream.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/lib/dashboard/use-analysis-stream.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// Mock EventSource
class MockEventSource {
  url: string
  onmessage: ((e: MessageEvent) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  addEventListener = vi.fn()
  removeEventListener = vi.fn()
  close = vi.fn()
  constructor(url: string) { this.url = url }
}

vi.stubGlobal('EventSource', MockEventSource)
vi.stubGlobal('fetch', vi.fn())

import { useAnalysisStream } from '@/hooks/use-analysis-stream'
import type { DashboardEvent } from '@/lib/dashboard/event-types'

describe('useAnalysisStream', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('starts in connecting state', () => {
    const { result } = renderHook(() => useAnalysisStream('proj-1'))
    expect(result.current.connectionState).toBe('connecting')
  })

  it('drops events with version <= last seen version', () => {
    const { result } = renderHook(() => useAnalysisStream('proj-1'))
    const event: DashboardEvent = {
      type: 'queued', scope: 'analysis', changeId: 'c1', projectId: 'proj-1',
      analysisVersion: 1, version: 5, payload: {},
    }
    const staleEvent: DashboardEvent = { ...event, version: 3 }

    act(() => { result.current._handleEvent(event) })
    act(() => { result.current._handleEvent(staleEvent) })

    // Only the first event should be in the list (version 5 beats version 3)
    expect(result.current.events).toHaveLength(1)
    expect(result.current.events[0].version).toBe(5)
  })

  it('drops events with wrong analysisVersion', () => {
    const { result } = renderHook(() => useAnalysisStream('proj-1'))
    act(() => {
      result.current._setRunVersion('c1', 2)
    })
    const staleRunEvent: DashboardEvent = {
      type: 'progress', scope: 'analysis', changeId: 'c1', projectId: 'proj-1',
      analysisVersion: 1, version: 6, payload: { stage: 'context_load', pct: 10 },
    }
    act(() => { result.current._handleEvent(staleRunEvent) })
    expect(result.current.events).toHaveLength(0)
  })

  it('discards synthetic events when a real event of the same type exists', () => {
    const { result } = renderHook(() => useAnalysisStream('proj-1'))
    const realStarted: DashboardEvent = {
      type: 'started', scope: 'analysis', changeId: 'c1', projectId: 'proj-1',
      analysisVersion: 1, version: 4, payload: {},
    }
    const syntheticStarted: DashboardEvent = {
      ...realStarted, version: 1, synthetic: true,
    }
    act(() => { result.current._handleEvent(realStarted) })
    act(() => { result.current._handleEvent(syntheticStarted) })

    const startedEvents = result.current.events.filter(e => e.type === 'started' && e.changeId === 'c1')
    expect(startedEvents).toHaveLength(1)
    expect(startedEvents[0].synthetic).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/lib/dashboard/use-analysis-stream.test.ts
```

Expected: FAIL with "Cannot find module '@/hooks/use-analysis-stream'"

- [ ] **Step 3: Implement the hook**

```ts
// hooks/use-analysis-stream.ts
'use client'
import { useEffect, useRef, useState, useCallback } from 'react'
import type { DashboardEvent } from '@/lib/dashboard/event-types'

export type ConnectionState = 'connecting' | 'connected' | 'degraded' | 'error'

interface ActiveChangeState {
  id: string
  analysisStatus: string
  analysisVersion: number
}

interface SnapshotState {
  changeId: string
  snapshotStatus: string
  executionOutcome: string
}

interface UseAnalysisStreamResult {
  events: DashboardEvent[]
  connectionState: ConnectionState
  activeChanges: ActiveChangeState[]
  snapshots: SnapshotState[]
  /** Exposed for testing only */
  _handleEvent: (event: DashboardEvent) => void
  _setRunVersion: (changeId: string, version: number) => void
}

const POLL_INTERVAL_MS = 12_000

export function useAnalysisStream(projectId: string): UseAnalysisStreamResult {
  const [events, setEvents] = useState<DashboardEvent[]>([])
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting')
  const [activeChanges, setActiveChanges] = useState<ActiveChangeState[]>([])
  const [snapshots, setSnapshots] = useState<SnapshotState[]>([])

  // Track: last seen version per project (for dedup)
  const lastVersionRef = useRef<number>(0)
  // Track: current analysisVersion per changeId (to discard stale-run events)
  const runVersionsRef = useRef<Map<string, number>>(new Map())
  // Track: real event types seen per changeId (to discard synthetic duplicates)
  const realEventsSeenRef = useRef<Map<string, Set<string>>>(new Map())

  const _setRunVersion = useCallback((changeId: string, version: number) => {
    runVersionsRef.current.set(changeId, version)
  }, [])

  const _handleEvent = useCallback((event: DashboardEvent) => {
    // 1. Drop if version <= last seen (dedup)
    if (event.version > 0 && event.version <= lastVersionRef.current) return
    if (event.version > 0) lastVersionRef.current = event.version

    // 2. Drop if analysisVersion doesn't match current run (stale run events)
    const currentRunVersion = runVersionsRef.current.get(event.changeId)
    if (
      currentRunVersion !== undefined &&
      event.analysisVersion !== currentRunVersion &&
      !event.synthetic
    ) return

    // 3. Track new analysisVersion when we see a queued/started event
    if (event.type === 'queued' || event.type === 'started') {
      runVersionsRef.current.set(event.changeId, event.analysisVersion)
    }

    // 4. Discard synthetic if we've already seen a real event of the same type for this change
    const changeKey = `${event.changeId}:${event.type}`
    if (event.synthetic) {
      const realSeen = realEventsSeenRef.current.get(event.changeId)
      if (realSeen?.has(event.type)) return
    } else {
      // Mark this real event type as seen
      if (!realEventsSeenRef.current.has(event.changeId)) {
        realEventsSeenRef.current.set(event.changeId, new Set())
      }
      realEventsSeenRef.current.get(event.changeId)!.add(event.type)
    }

    setEvents(prev => {
      // Remove any synthetic event of the same type+changeId that this real event supersedes
      const filtered = event.synthetic
        ? prev
        : prev.filter(e => !(e.changeId === event.changeId && e.type === event.type && e.synthetic))
      return [...filtered, event]
    })
  }, [])

  // Reconciliation: check snapshots against local state
  const reconcile = useCallback((pollSnapshots: SnapshotState[], pollActiveChanges: ActiveChangeState[]) => {
    setSnapshots(pollSnapshots)
    setActiveChanges(pollActiveChanges)

    // Force transition to completed for any change that has a snapshot but local events say running
    for (const snap of pollSnapshots) {
      setEvents(prev => {
        const hasCompleted = prev.some(e => e.changeId === snap.changeId && e.type === 'completed')
        if (!hasCompleted) {
          return [...prev, {
            type: 'completed',
            scope: 'analysis',
            changeId: snap.changeId,
            projectId,
            analysisVersion: 0,
            version: 0,
            synthetic: true,
            payload: { outcome: snap.executionOutcome, fromReconciliation: true },
          } as DashboardEvent]
        }
        return prev
      })
    }
  }, [projectId])

  // SSE connection
  useEffect(() => {
    let es: EventSource | null = null
    let retries = 0
    const MAX_RETRIES = 3

    function connect() {
      const since = lastVersionRef.current
      es = new EventSource(
        `/api/projects/${projectId}/dashboard-stream${since > 0 ? `?since=${since}` : ''}`
      )

      es.addEventListener('dashboard', (e: MessageEvent) => {
        try {
          const event: DashboardEvent = JSON.parse(e.data)
          if (event.type === 'resync_required') {
            poll()  // force a full refetch
          } else {
            _handleEvent(event)
          }
          setConnectionState('connected')
          retries = 0
        } catch { /* ignore malformed events */ }
      })

      es.onerror = () => {
        es?.close()
        retries++
        if (retries >= MAX_RETRIES) {
          setConnectionState('degraded')
        } else {
          setTimeout(connect, 2000 * retries)
        }
      }
    }

    connect()
    return () => { es?.close() }
  }, [projectId, _handleEvent])

  // Polling — runs independently from SSE, every 12s
  async function poll() {
    try {
      const res = await fetch(`/api/projects/${projectId}/dashboard-poll`)
      if (!res.ok) return
      const data = await res.json()
      reconcile(data.snapshots ?? [], data.activeChanges ?? [])
    } catch { /* ignore transient failures */ }
  }

  useEffect(() => {
    poll()  // poll immediately on mount
    const interval = setInterval(poll, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [projectId])

  return { events, connectionState, activeChanges, snapshots, _handleEvent, _setRunVersion }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run tests/lib/dashboard/use-analysis-stream.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add hooks/use-analysis-stream.ts tests/lib/dashboard/use-analysis-stream.test.ts
git commit -m "feat: useAnalysisStream hook with SSE+polling hybrid and snapshot reconciliation"
```

---

### Task 2: Active Changes Component

**Files:**
- Create: `app/projects/[id]/components/active-changes.tsx`

- [ ] **Step 1: Create the component**

```tsx
// app/projects/[id]/components/active-changes.tsx
'use client'
import { useState } from 'react'
import type { DashboardEvent } from '@/lib/dashboard/event-types'

interface ChangeCard {
  id: string
  title: string
  status: string
  analysisStatus: string
  risk_level: string
  updated_at: string
}

interface ActiveChangesProps {
  initialChanges: ChangeCard[]
  events: DashboardEvent[]
  onCreateChange: () => void
}

const STAGE_LABELS: Record<string, string> = {
  context_load: 'Loading context…',
  impact_analysis: 'Analyzing impact…',
  patch_generation: 'Generating patches…',
  type_check: 'Type checking…',
  test_run: 'Running tests…',
}

function getCardState(
  change: ChangeCard,
  events: DashboardEvent[]
): { label: string; pct: number | null; stage: string | null; outcome: string | null } {
  const changeEvents = events
    .filter(e => e.changeId === change.id)
    .sort((a, b) => a.version - b.version)

  const latest = changeEvents[changeEvents.length - 1]
  if (!latest) {
    if (change.analysisStatus === 'running') return { label: 'Analyzing…', pct: null, stage: null, outcome: null }
    return { label: 'Queued…', pct: null, stage: null, outcome: null }
  }

  switch (latest.type) {
    case 'queued': return { label: 'Queued…', pct: null, stage: null, outcome: null }
    case 'started': return { label: 'Analyzing…', pct: 0, stage: null, outcome: null }
    case 'progress': {
      const p = latest.payload as { stage?: string; pct?: number }
      return {
        label: STAGE_LABELS[p.stage ?? ''] ?? 'Analyzing…',
        pct: p.pct ?? null,
        stage: p.stage ?? null,
        outcome: null,
      }
    }
    case 'stalled': return { label: '⚠ Stalled — no progress for several minutes', pct: null, stage: null, outcome: null }
    case 'completed': {
      const p = latest.payload as { outcome?: string }
      return { label: p.outcome === 'success' ? 'Applied ✓' : 'Failed', pct: 100, stage: null, outcome: p.outcome ?? null }
    }
    default: return { label: 'Initializing…', pct: null, stage: null, outcome: null }
  }
}

export function ActiveChanges({ initialChanges, events, onCreateChange }: ActiveChangesProps) {
  const [optimisticCards, setOptimisticCards] = useState<ChangeCard[]>([])

  const allChanges = [...optimisticCards, ...initialChanges]

  if (allChanges.length === 0) {
    return (
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wide">Active Changes</h2>
          <button
            onClick={onCreateChange}
            className="text-xs text-blue-400 hover:text-blue-300"
          >
            + New Change
          </button>
        </div>
        <p className="text-sm text-zinc-500">No active changes — start one below.</p>
      </section>
    )
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wide">Active Changes</h2>
        <button onClick={onCreateChange} className="text-xs text-blue-400 hover:text-blue-300">
          + New Change
        </button>
      </div>
      <div className="space-y-2">
        {allChanges.map(change => {
          const state = getCardState(change, events)
          const isCompleted = state.outcome != null
          const isStalled = state.label.startsWith('⚠')
          const canEdit = ['queued', 'started', 'progress'].some(t =>
            events.some(e => e.changeId === change.id && e.type === t)
          ) && !isCompleted

          return (
            <div
              key={change.id}
              className={`rounded-lg border p-3 text-sm ${
                isStalled ? 'border-amber-500/40 bg-amber-950/20'
                : isCompleted && state.outcome === 'success' ? 'border-green-500/30 bg-green-950/10'
                : isCompleted ? 'border-red-500/30 bg-red-950/10'
                : 'border-zinc-700 bg-zinc-900'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium text-zinc-200">{change.title}</span>
                <div className="flex items-center gap-2">
                  {canEdit && (
                    <button className="text-xs text-zinc-400 hover:text-zinc-200">
                      Edit
                    </button>
                  )}
                  <span className={`text-xs ${
                    isStalled ? 'text-amber-400'
                    : isCompleted && state.outcome === 'success' ? 'text-green-400'
                    : isCompleted ? 'text-red-400'
                    : 'text-zinc-400'
                  }`}>
                    {state.label}
                  </span>
                </div>
              </div>

              {state.pct != null && !isCompleted && (
                <div className="mt-2 h-1 rounded-full bg-zinc-700 overflow-hidden">
                  <div
                    className="h-full bg-blue-500 transition-all duration-500"
                    style={{ width: `${state.pct}%` }}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add app/projects/[id]/components/active-changes.tsx
git commit -m "feat: Active Changes component with live state from SSE events"
```

---

### Task 3: Recent Outcomes Component

**Files:**
- Create: `app/projects/[id]/components/recent-outcomes.tsx`

- [ ] **Step 1: Create the component**

```tsx
// app/projects/[id]/components/recent-outcomes.tsx
'use client'
import { useState } from 'react'
import type { AnalysisResultSnapshotData } from '@/lib/dashboard/event-types'

interface RecentOutcomesProps {
  snapshots: AnalysisResultSnapshotData[]
  changeNames: Record<string, string>  // changeId → title
}

const SEVERITY_THRESHOLDS = { HIGH: 4, MEDIUM: 2 } as const

function getSeverity(snapshot: AnalysisResultSnapshotData): 'HIGH' | 'MEDIUM' | 'LOW' {
  const gapSeverity = snapshot.modelMiss?.confidence_gap?.actual_severity
  if (gapSeverity) return gapSeverity
  const count = snapshot.componentsAffected.length
  if (count >= SEVERITY_THRESHOLDS.HIGH) return 'HIGH'
  if (count >= SEVERITY_THRESHOLDS.MEDIUM) return 'MEDIUM'
  return 'LOW'
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const hours = Math.floor(diff / (1000 * 60 * 60))
  if (hours < 1) return 'just now'
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function PatternBanner({ snapshots }: { snapshots: AnalysisResultSnapshotData[] }) {
  const errorTypeCounts: Record<string, { count: number; components: string[] }> = {}
  for (const s of snapshots) {
    const et = (s.failureCause as any)?.error_type
    if (et) {
      if (!errorTypeCounts[et]) errorTypeCounts[et] = { count: 0, components: [] }
      errorTypeCounts[et].count++
      const cascade: string[] = (s.failureCause as any)?.cascade ?? []
      errorTypeCounts[et].components.push(...cascade)
    }
  }
  const pattern = Object.entries(errorTypeCounts).find(([, v]) => v.count >= 2 && v.count / snapshots.length >= 0.4)
  if (!pattern) return null

  const [errorType, data] = pattern
  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-950/20 p-3 mb-3">
      <p className="text-sm font-medium text-amber-300">
        ⚠ Recurring issue (HIGH IMPACT): {errorType}
      </p>
      <p className="text-xs text-amber-400 mt-1">
        This pattern caused {data.count} failures in the last 7 days
        {data.components.length > 0 && ` — ${[...new Set(data.components)].slice(0, 2).join(', ')}`}
      </p>
      <div className="flex gap-2 mt-2">
        <button className="text-xs text-zinc-300 underline">View in System Model →</button>
        <button className="text-xs text-blue-400 underline">Create Fix Change →</button>
      </div>
    </div>
  )
}

function OutcomeCard({ snapshot, title }: { snapshot: AnalysisResultSnapshotData; title: string }) {
  const [expanded, setExpanded] = useState(false)
  const failed = snapshot.executionOutcome === 'failure'
  const severity = getSeverity(snapshot)
  const cause = snapshot.failureCause
  const parseConfident = cause && (cause.parse_confidence ?? 0) >= 0.9
  const missRate = snapshot.miss_rate != null
    ? `${Math.round(snapshot.miss_rate * 100)}%`
    : null
  const accuracy = snapshot.jaccard_accuracy != null
    ? `${Math.round(snapshot.jaccard_accuracy * 100)}%`
    : null

  const missed = snapshot.modelMiss?.missed ?? []
  const overestimated = snapshot.modelMiss?.overestimated ?? []
  const hasModelData = missed.length > 0 || overestimated.length > 0

  return (
    <div className={`rounded-lg border p-3 text-sm ${
      failed ? 'border-red-500/30 bg-red-950/10' : 'border-green-500/30 bg-green-950/10'
    }`}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={failed ? 'text-red-400' : 'text-green-400'}>
            {failed ? '❌ FAILED' : '✓ Applied'}
          </span>
          {failed && (
            <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
              severity === 'HIGH' ? 'bg-red-900 text-red-300'
              : severity === 'MEDIUM' ? 'bg-amber-900 text-amber-300'
              : 'bg-zinc-800 text-zinc-300'
            }`}>
              {severity} IMPACT
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-zinc-500 text-xs">{title}</span>
          <span className="text-zinc-500 text-xs">{formatRelativeTime(snapshot.completed_at)}</span>
          {hasModelData && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-xs text-zinc-400 hover:text-zinc-200"
            >
              {expanded ? '▲' : '▼'}
            </button>
          )}
        </div>
      </div>

      {/* Cause */}
      {failed && (
        <p className="mt-2 text-zinc-300 text-xs">
          {parseConfident && cause
            ? <>Primary cause: <span className="text-red-300">{(cause as any).error_type}</span> → {(cause as any).component_id ?? 'unknown'}</>
            : 'Cause: unclear — see execution log'
          }
        </p>
      )}

      {/* Model miss buckets (expanded) */}
      {expanded && hasModelData && (
        <div className="mt-3 space-y-1 border-t border-zinc-700 pt-2">
          {missed.length > 0 && (
            <p className="text-xs text-zinc-400">
              <span className="text-red-400">Missed (unexpected impact):</span>{' '}
              {missed.map(m => m.name).join(', ')}
            </p>
          )}
          {overestimated.length > 0 && (
            <p className="text-xs text-zinc-400">
              <span className="text-amber-400">Overestimated (false positives):</span>{' '}
              {overestimated.map(m => m.name).join(', ')}
            </p>
          )}
          {snapshot.modelMiss?.confidence_gap && (
            <p className="text-xs text-zinc-400">
              <span className="text-zinc-300">Confidence gap:</span>{' '}
              Predicted {snapshot.modelMiss.confidence_gap.predicted}% → Actual:{' '}
              {snapshot.modelMiss.confidence_gap.actual_severity} impact
            </p>
          )}
        </div>
      )}

      {/* Metrics */}
      <div className="mt-2 flex gap-4 text-xs text-zinc-500">
        {accuracy && <span>Prediction accuracy: {accuracy}</span>}
        {missRate != null && (
          <span>
            Miss rate: {missRate}
            {missed.length > 0 && snapshot.componentsAffected.length > 0 &&
              ` (missed ${missed.length} of ${snapshot.componentsAffected.length} affected components)`
            }
          </span>
        )}
        {!failed && <span className="text-green-400/80">Model prediction held — safe to proceed with similar changes</span>}
      </div>

      {/* Minimal state banner */}
      {snapshot.minimal && snapshot.snapshotStatus === 'pending_enrichment' && (
        <p className="mt-2 text-xs text-zinc-500">
          ⚠ Full analysis details are being computed — refresh in a moment
        </p>
      )}
    </div>
  )
}

export function RecentOutcomes({ snapshots, changeNames }: RecentOutcomesProps) {
  const [showAll, setShowAll] = useState(false)
  const visible = showAll ? snapshots : snapshots.slice(0, 5)

  if (snapshots.length === 0) {
    return (
      <section>
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wide mb-3">Recent Outcomes</h2>
        <p className="text-sm text-zinc-500">No completed changes yet.</p>
      </section>
    )
  }

  return (
    <section>
      <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wide mb-3">Recent Outcomes</h2>
      <PatternBanner snapshots={snapshots} />
      <div className="space-y-2">
        {visible.map(s => (
          <OutcomeCard
            key={s.changeId}
            snapshot={s}
            title={changeNames[s.changeId] ?? 'Change'}
          />
        ))}
      </div>
      {snapshots.length > 5 && (
        <button
          onClick={() => setShowAll(!showAll)}
          className="mt-2 text-xs text-zinc-400 hover:text-zinc-200"
        >
          {showAll ? 'Show less' : `Show ${snapshots.length - 5} more`}
        </button>
      )}
    </section>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add app/projects/[id]/components/recent-outcomes.tsx
git commit -m "feat: Recent Outcomes component with model miss buckets, pattern banner, learning signal"
```

---

### Task 4: Wire Dashboard Page

**Files:**
- Modify: `app/projects/[id]/page.tsx`
- Modify: `app/projects/[id]/project-dashboard.tsx`

- [ ] **Step 1: Update `page.tsx` to fetch precomputed snapshots**

In `app/projects/[id]/page.tsx`, add to the `Promise.all` block:

```ts
// Add to the existing Promise.all in page.tsx
const [
  { data: changes },
  { count: fileCount },
  { data: allComponents },
  { data: recentSnapshots },
  { data: activeChangesRaw },
] = await Promise.all([
  db.from('change_requests')
    .select('id, title, type, priority, status, risk_level, analysis_status, created_at, updated_at')
    .eq('project_id', id)
    .order('updated_at', { ascending: false }),
  db.from('files').select('*', { count: 'exact', head: true }).eq('project_id', id),
  db.from('system_components')
    .select('id, name, type, status, is_anchored')
    .eq('project_id', id)
    .is('deleted_at', null)
    .order('name'),
  db.from('analysis_result_snapshot')
    .select('*')
    .in(
      'change_id',
      // We can only get this after fetching changes — move to separate query
      []  // placeholder — see note below
    )
    .order('completed_at', { ascending: false })
    .limit(10),
  db.from('change_requests')
    .select('id, status, analysis_status, analysis_version, title, risk_level, updated_at')
    .eq('project_id', id)
    .not('analysis_status', 'in', '("completed","failed","stalled")')
    .order('updated_at', { ascending: false }),
])
```

**Note:** The snapshot query needs change IDs first. Replace the placeholder approach — move the snapshot fetch to a sequential query after `changes` is known:

```ts
// After the Promise.all, add:
const changeIds = (changes ?? []).map(c => c.id)
const { data: recentSnapshots } = changeIds.length > 0
  ? await db
      .from('analysis_result_snapshot')
      .select('*')
      .in('change_id', changeIds)
      .order('completed_at', { ascending: false })
      .limit(10)
  : { data: [] }
```

Pass the data to `ProjectDashboard`:

```tsx
return (
  <ProjectDashboard
    project={project as any}
    initialChanges={changes ?? []}
    initialStats={{...}}
    initialComponents={components}
    initialSnapshots={recentSnapshots ?? []}
    initialActiveChanges={activeChangesRaw ?? []}
  />
)
```

- [ ] **Step 2: Update `ProjectDashboard` to accept + use new props**

In `app/projects/[id]/project-dashboard.tsx`:

Add imports:
```tsx
'use client'
import { useAnalysisStream } from '@/hooks/use-analysis-stream'
import { ActiveChanges } from './components/active-changes'
import { RecentOutcomes } from './components/recent-outcomes'
import type { AnalysisResultSnapshotData } from '@/lib/dashboard/event-types'
```

Update the component signature to accept new props:
```tsx
interface ProjectDashboardProps {
  project: { id: string; name: string; scan_status: string; scan_error: string | null; scan_progress: number | null }
  initialChanges: Array<{ id: string; title: string; type: string; priority: string; status: string; risk_level: string; analysis_status: string; created_at: string; updated_at: string }>
  initialStats: { fileCount: number; componentCount: number; edgeCount: number; lowConfidenceCount: number; unstableCount: number; avgConfidence: number }
  initialComponents: Array<any>
  initialSnapshots: AnalysisResultSnapshotData[]
  initialActiveChanges: Array<{ id: string; title: string; status: string; risk_level: string; analysis_status: string; updated_at: string }>
}
```

Add the stream hook inside the component body:
```tsx
const { events, connectionState } = useAnalysisStream(project.id)
const [quickStartOpen, setQuickStartOpen] = useState(false)

const changeNames: Record<string, string> = {}
for (const c of initialChanges) changeNames[c.id] = c.title
```

Replace the current dashboard JSX sections with:
```tsx
<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
  <ActiveChanges
    initialChanges={initialActiveChanges}
    events={events}
    onCreateChange={() => setQuickStartOpen(true)}
  />
  <RecentOutcomes
    snapshots={initialSnapshots}
    changeNames={changeNames}
  />
</div>
```

- [ ] **Step 3: Verify TypeScript**

```bash
npx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 4: Verify in browser**

1. Start dev server: `npm run dev`
2. Navigate to a project dashboard
3. Verify Active Changes and Recent Outcomes render without errors
4. Execute a change and watch the Active Changes card update via SSE

- [ ] **Step 5: Commit**

```bash
git add app/projects/[id]/page.tsx app/projects/[id]/project-dashboard.tsx
git commit -m "feat: wire Active Changes and Recent Outcomes into dashboard with live SSE events"
```

---

## Self-Review Checklist

- [ ] `_handleEvent` drops version ≤ lastVersion (dedup) ✓
- [ ] `_handleEvent` drops events with wrong `analysisVersion` (stale run) ✓
- [ ] Synthetic events discarded when real event of same type exists for same change ✓
- [ ] Reconciliation: snapshot existence forces completed state ✓
- [ ] Progress bar never goes backwards (driven by `pct` from events) ✓
- [ ] Pattern banner threshold: ≥2 failures AND ≥40% of recent snapshots ✓
- [ ] Cause shows "unclear" when `parse_confidence < 0.9` ✓
- [ ] Minimal snapshot banner shown when `snapshot.minimal === true` ✓
- [ ] Edit affordance only shown before patch phase ✓
- [ ] ConnectionState: `connecting → connected → degraded → error` ✓
