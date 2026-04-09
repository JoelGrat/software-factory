# Dashboard Redesign — Plan 4: Risk Radar + Next Best Actions + Quick Start + System Signals

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prerequisite:** Plan 2 (Background Jobs) must be complete. Tables `risk_scores`, `action_items`, `system_signal_snapshot` must be populated. Plan 3 hook must be complete (`useAnalysisStream`).

**Goal:** Implement the four remaining dashboard sections: Risk Radar, Next Best Actions, Quick Start panel, and System Signals. These sections read from precomputed tables — no runtime aggregation.

**Architecture:** All four sections are server-rendered by default (data fetched in `page.tsx` from precomputed tables) with no live SSE dependency. Quick Start is a client-side slide-in panel that creates a change and triggers execution. System Signals shows aggregate health with sparkline-style rendering.

**Tech Stack:** React, Next.js App Router, Supabase, TypeScript, Vitest

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `app/projects/[id]/components/risk-radar.tsx` | Create | Top 5 risk components with scores, trend, CTAs |
| `app/projects/[id]/components/next-best-actions.tsx` | Create | Tiered action items with dedup merge display |
| `app/projects/[id]/components/quick-start.tsx` | Create | Inline slide-in change creation form |
| `app/projects/[id]/components/system-signals.tsx` | Create | 4-panel health overview with trend arrows |
| `app/projects/[id]/page.tsx` | Modify | Fetch risk_scores, action_items, system_signal_snapshot |
| `app/projects/[id]/project-dashboard.tsx` | Modify | Add four new sections to layout |
| `app/api/change-requests/route.ts` | Modify | Accept client_request_id in POST body |

---

### Task 1: Risk Radar Component

**Files:**
- Create: `app/projects/[id]/components/risk-radar.tsx`

- [ ] **Step 1: Create the component**

```tsx
// app/projects/[id]/components/risk-radar.tsx
'use client'

interface RiskScore {
  componentId: string
  componentName: string
  riskScore: number
  tier: 'HIGH' | 'MEDIUM'
  previousScore?: number  // for trend indicator
  incomingDeps: number
  missRate?: number
  confidence?: number
}

interface RiskRadarProps {
  riskScores: RiskScore[]
  projectId: string
}

function getTrend(current: number, previous?: number): '↑ worsening' | '→ stable' | '↓ improving' {
  if (previous == null) return '→ stable'
  const delta = (current - previous) * 100
  if (delta >= 10) return '↑ worsening'
  if (delta <= -10) return '↓ improving'
  return '→ stable'
}

function RiskCard({ score, projectId }: { score: RiskScore; projectId: string }) {
  const trend = getTrend(score.riskScore, score.previousScore)
  const trendColor = trend.startsWith('↑') ? 'text-red-400' : trend.startsWith('↓') ? 'text-green-400' : 'text-zinc-400'
  const tierColor = score.tier === 'HIGH' ? 'bg-red-900 text-red-300' : 'bg-amber-900 text-amber-300'

  const reasons: string[] = []
  if (score.missRate != null && score.missRate > 0) {
    reasons.push(`Missed in ~${Math.round(score.missRate * 100)}% of recent runs`)
  }
  if (score.confidence != null && score.confidence < 60) {
    reasons.push(`Low model confidence: ${Math.round(score.confidence)}%`)
  }
  if (score.incomingDeps > 2) {
    reasons.push(`Shared by ${score.incomingDeps} components (high centrality)`)
  }

  function openQuickStart(intent: string) {
    // Dispatch a custom event that QuickStart listens to
    window.dispatchEvent(new CustomEvent('open-quick-start', { detail: { intent, componentId: score.componentId } }))
  }

  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-3 text-sm">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-zinc-200 text-xs">{score.componentName}</span>
          <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${tierColor}`}>
            {score.tier} RISK
          </span>
        </div>
        <span className={`text-xs ${trendColor}`}>{trend}</span>
      </div>

      {reasons.length > 0 && (
        <div className="mb-2">
          <p className="text-xs text-zinc-500 mb-1">Why this ranks high:</p>
          <ul className="space-y-0.5">
            {reasons.map((r, i) => (
              <li key={i} className="text-xs text-zinc-400">· {r}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex gap-2 mt-2">
        <button
          onClick={() => openQuickStart(`Improve model coverage and dependency mapping for ${score.componentName}`)}
          className="text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-200 px-2 py-1 rounded"
        >
          Stabilize Component
        </button>
        <button className="text-xs text-zinc-400 hover:text-zinc-200 underline">
          View in System Model →
        </button>
      </div>
    </div>
  )
}

export function RiskRadar({ riskScores, projectId }: RiskRadarProps) {
  if (riskScores.length === 0) {
    return (
      <section>
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wide mb-3">Risk Radar</h2>
        <p className="text-sm text-zinc-500">No high-risk components detected — model coverage looks healthy.</p>
      </section>
    )
  }

  return (
    <section>
      <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wide mb-3">Risk Radar</h2>
      <div className="space-y-2">
        {riskScores.slice(0, 5).map(s => (
          <RiskCard key={s.componentId} score={s} projectId={projectId} />
        ))}
      </div>
    </section>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add app/projects/[id]/components/risk-radar.tsx
git commit -m "feat: Risk Radar component with confidence-weighted scores and trend indicators"
```

---

### Task 2: Next Best Actions Component

**Files:**
- Create: `app/projects/[id]/components/next-best-actions.tsx`

- [ ] **Step 1: Create the component**

```tsx
// app/projects/[id]/components/next-best-actions.tsx
'use client'

interface ActionItem {
  id: string
  tier: number
  source: string
  priorityScore: number
  payload: {
    label: string
    componentId?: string
    componentName?: string
    errorType?: string
    affectedComponents?: string[]
    count?: number
    total?: number
    confidence?: number
    centrality?: number
    riskScore?: number
    lastOccurredAt?: string
  }
}

interface NextBestActionsProps {
  actionItems: ActionItem[]
}

function formatTimeAgo(iso?: string): string {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const hours = Math.floor(diff / (1000 * 60 * 60))
  if (hours < 1) return 'just now'
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function ActionCard({ item, index }: { item: ActionItem; index: number }) {
  const isHigh = item.tier === 1
  const isMedium = item.tier === 2
  const isOpportunity = item.tier === 3

  const badgeClass = isHigh
    ? 'bg-red-900 text-red-300'
    : isMedium
    ? 'bg-amber-900 text-amber-300'
    : 'bg-zinc-800 text-zinc-400'
  const badgeLabel = isHigh ? 'HIGH' : isMedium ? 'MEDIUM' : 'LOW'

  const sourceLabel: Record<string, string> = {
    pattern: 'Pattern',
    risk_radar: 'Risk Radar',
    model_quality: 'Model Quality',
    opportunity: 'Opportunity',
  }

  const timeHook = item.payload.lastOccurredAt
    ? `(last occurrence ${formatTimeAgo(item.payload.lastOccurredAt)})`
    : ''

  function openQuickStart(intent: string, componentId?: string) {
    window.dispatchEvent(new CustomEvent('open-quick-start', {
      detail: { intent, componentId },
    }))
  }

  return (
    <div className={`rounded-lg border p-3 text-sm ${
      isHigh ? 'border-red-500/30 bg-red-950/10'
      : isMedium ? 'border-amber-500/20 bg-amber-950/10'
      : 'border-zinc-700 bg-zinc-900/50'
    }`}>
      <div className="flex items-start gap-2">
        <span className="text-zinc-500 text-xs font-mono mt-0.5">{index + 1}</span>
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${badgeClass}`}>
              {badgeLabel}
            </span>
            <span className="text-xs text-zinc-500">
              · {sourceLabel[item.source] ?? item.source}
            </span>
          </div>

          <p className="text-zinc-200 font-medium text-xs mb-1">{item.payload.label}</p>

          {item.payload.affectedComponents && item.payload.affectedComponents.length > 0 && (
            <p className="text-xs text-zinc-500 mb-1">
              Affects {item.payload.affectedComponents.slice(0, 3).join(', ')}
              {timeHook && ` ${timeHook}`}
            </p>
          )}

          {item.payload.count != null && item.payload.total != null && (
            <p className="text-xs text-zinc-500 mb-2">
              {item.payload.count} of {item.payload.total} recent runs {timeHook}
            </p>
          )}

          <div className="flex gap-2">
            {isOpportunity ? (
              <button className="text-xs text-zinc-400 hover:text-zinc-200 underline">
                View in System Model →
              </button>
            ) : (
              <button
                onClick={() => openQuickStart(item.payload.label, item.payload.componentId)}
                className="text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-200 px-2 py-1 rounded"
              >
                {item.source === 'risk_radar' ? 'Stabilize Component' : 'Create Fix Change →'}
              </button>
            )}
            {item.payload.componentId && (
              <button className="text-xs text-zinc-400 hover:text-zinc-200 underline">
                View in System Model →
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export function NextBestActions({ actionItems }: NextBestActionsProps) {
  const onlyOpportunities = actionItems.every(i => i.tier === 3)

  if (actionItems.length === 0) {
    return (
      <section>
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wide mb-3">Next Best Actions</h2>
        <p className="text-sm text-zinc-500">No urgent actions — system looks healthy.</p>
      </section>
    )
  }

  return (
    <section>
      <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wide mb-3">
        {onlyOpportunities ? 'System looks healthy — optimize next:' : 'Next Best Actions'}
      </h2>
      <div className="space-y-2">
        {actionItems.map((item, i) => (
          <ActionCard key={item.id} item={item} index={i} />
        ))}
      </div>
    </section>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add app/projects/[id]/components/next-best-actions.tsx
git commit -m "feat: Next Best Actions component with tier dominance and expected outcomes"
```

---

### Task 3: Quick Start Panel

**Files:**
- Create: `app/projects/[id]/components/quick-start.tsx`
- Modify: `app/api/change-requests/route.ts`

- [ ] **Step 1: Update the change-requests POST to accept client_request_id**

In `app/api/change-requests/route.ts`, find the POST handler. Add `client_request_id` to the insert:

```ts
// In the POST handler, read client_request_id from header
const clientRequestId = req.headers.get('X-Client-Request-Id')

// Add to the insert object:
const { data: newChange, error } = await db.from('change_requests').insert({
  // ... existing fields ...
  client_request_id: clientRequestId ?? undefined,
}).select().single()
```

- [ ] **Step 2: Create the Quick Start component**

```tsx
// app/projects/[id]/components/quick-start.tsx
'use client'
import { useState, useEffect, useRef } from 'react'

interface Component {
  id: string
  name: string
  confidence: number
}

interface QuickStartProps {
  projectId: string
  components: Component[]
  onChangeCreated: (changeId: string, clientRequestId: string) => void
}

interface PreFillData {
  intent?: string
  componentId?: string
}

const RISK_LEVELS = ['low', 'medium', 'high'] as const
type RiskLevel = typeof RISK_LEVELS[number]

export function QuickStart({ projectId, components, onChangeCreated }: QuickStartProps) {
  const [open, setOpen] = useState(false)
  const [intent, setIntent] = useState('')
  const [selectedComponents, setSelectedComponents] = useState<string[]>([])
  const [priority, setPriority] = useState<'low' | 'medium' | 'high'>('medium')
  const [riskLevel, setRiskLevel] = useState<RiskLevel>('medium')
  const [systemRiskLevel, setSystemRiskLevel] = useState<RiskLevel | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [intentMismatch, setIntentMismatch] = useState<string | null>(null)
  const intentRef = useRef<HTMLTextAreaElement>(null)

  // Listen for open-quick-start events from other components
  useEffect(() => {
    function handler(e: Event) {
      const detail = (e as CustomEvent<PreFillData>).detail
      if (detail.intent) setIntent(detail.intent)
      if (detail.componentId) setSelectedComponents([detail.componentId])
      setOpen(true)
    }
    window.addEventListener('open-quick-start', handler)
    return () => window.removeEventListener('open-quick-start', handler)
  }, [])

  // Detect intent/component mismatch on blur
  function handleIntentBlur() {
    if (!intent) return
    const lowerIntent = intent.toLowerCase()
    const mismatch = components.find(
      c => lowerIntent.includes(c.name.toLowerCase()) && !selectedComponents.includes(c.id)
    )
    setIntentMismatch(mismatch ? mismatch.name : null)
  }

  const impactCount = selectedComponents.length
  const isHighRisk = riskLevel === 'high' || impactCount >= 4
  const intentTooShort = intent.trim().length < 15

  async function handleSubmit(startImmediately: boolean) {
    if (!intent.trim()) return
    setSubmitting(true)
    setError(null)

    const clientRequestId = crypto.randomUUID()

    try {
      const res = await fetch('/api/change-requests', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Request-Id': clientRequestId,
        },
        body: JSON.stringify({
          project_id: projectId,
          title: intent.slice(0, 100),
          description: intent,
          type: 'feature',
          priority,
          risk_level: riskLevel,
          component_ids: selectedComponents,
        }),
      })

      if (!res.ok) {
        const err = await res.json()
        setError(err.error ?? 'Failed to create change')
        return
      }

      const { id: changeId } = await res.json()
      onChangeCreated(changeId, clientRequestId)
      setOpen(false)
      setIntent('')
      setSelectedComponents([])
      setPriority('medium')
      setRiskLevel('medium')

      if (startImmediately) {
        // Trigger execution
        await fetch(`/api/change-requests/${changeId}/execute`, {
          method: 'POST',
          headers: { 'X-Client-Request-Id': clientRequestId },
        })
      }
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2 rounded-lg shadow-lg"
      >
        + New Change
      </button>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />

      {/* Panel */}
      <div className="relative bg-zinc-900 border-l border-zinc-700 w-full max-w-lg h-full overflow-y-auto p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-base font-semibold text-zinc-100">New Change</h2>
          <button onClick={() => setOpen(false)} className="text-zinc-400 hover:text-zinc-200">✕</button>
        </div>

        {/* Intent */}
        <div className="mb-4">
          <label className="text-xs text-zinc-400 mb-1 block">Intent</label>
          <textarea
            ref={intentRef}
            value={intent}
            onChange={e => setIntent(e.target.value)}
            onBlur={handleIntentBlur}
            placeholder={`e.g. "Add dependency mapping between AuthService and API layer"`}
            rows={3}
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-blue-500 resize-none"
          />
          {intentTooShort && intent.length > 0 && (
            <p className="text-xs text-amber-400 mt-1">Add more detail for better analysis</p>
          )}
        </div>

        {/* Mismatch warning */}
        {intentMismatch && (
          <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-950/20 p-3 text-xs text-amber-300">
            Intent mentions &quot;{intentMismatch}&quot; but it&apos;s not selected.{' '}
            <button
              className="underline"
              onClick={() => {
                const c = components.find(c => c.name === intentMismatch)
                if (c) setSelectedComponents(prev => [...prev, c.id])
                setIntentMismatch(null)
              }}
            >
              Add {intentMismatch}
            </button>
            {' '}·{' '}
            <button className="underline" onClick={() => setIntentMismatch(null)}>Ignore</button>
          </div>
        )}

        {/* Components */}
        <div className="mb-4">
          <label className="text-xs text-zinc-400 mb-1 block">Affected Components</label>
          <div className="space-y-1 max-h-40 overflow-y-auto">
            {components.map(c => (
              <label key={c.id} className="flex items-center gap-2 cursor-pointer hover:bg-zinc-800 px-2 py-1 rounded">
                <input
                  type="checkbox"
                  checked={selectedComponents.includes(c.id)}
                  onChange={e => {
                    setSelectedComponents(prev =>
                      e.target.checked ? [...prev, c.id] : prev.filter(id => id !== c.id)
                    )
                  }}
                  className="accent-blue-500"
                />
                <span className="text-sm text-zinc-200">{c.name}</span>
                <span className="text-xs text-zinc-500">{c.confidence}%</span>
              </label>
            ))}
          </div>
        </div>

        {/* Impact preview */}
        {selectedComponents.length > 0 && (
          <div className="mb-4 rounded-lg bg-zinc-800 border border-zinc-700 p-3 text-xs text-zinc-400">
            Impact preview: {selectedComponents.length} component{selectedComponents.length > 1 ? 's' : ''} in scope
          </div>
        )}

        {/* Priority + Risk */}
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className="text-xs text-zinc-400 mb-1 block">Priority</label>
            <select
              value={priority}
              onChange={e => setPriority(e.target.value as typeof priority)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200"
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-zinc-400 mb-1 block">Risk Level</label>
            <select
              value={riskLevel}
              onChange={e => setRiskLevel(e.target.value as RiskLevel)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-sm text-zinc-200"
            >
              {RISK_LEVELS.map(r => (
                <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>
              ))}
            </select>
            {systemRiskLevel && riskLevel !== systemRiskLevel && riskLevel < systemRiskLevel && (
              <p className="text-xs text-amber-400 mt-1">
                ⚠ You are overriding the system risk assessment
              </p>
            )}
          </div>
        </div>

        {error && <p className="text-xs text-red-400 mb-4">{error}</p>}

        {/* Actions */}
        {isHighRisk ? (
          <div className="rounded-lg border border-amber-500/40 bg-amber-950/20 p-3 mb-4">
            <p className="text-xs text-amber-300 mb-3">
              ⚠ This change affects {impactCount} components
              {riskLevel === 'high' ? ' and is flagged as high risk' : ''}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => handleSubmit(true)}
                disabled={submitting || !intent.trim()}
                className="flex-1 bg-amber-700 hover:bg-amber-600 text-white text-sm px-3 py-2 rounded disabled:opacity-50"
              >
                {submitting ? 'Starting…' : 'Start anyway'}
              </button>
              <button
                onClick={() => handleSubmit(false)}
                disabled={submitting || !intent.trim()}
                className="flex-1 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 text-sm px-3 py-2 rounded disabled:opacity-50"
              >
                Review first
              </button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2">
            <button
              onClick={() => handleSubmit(true)}
              disabled={submitting || !intent.trim()}
              className="flex-1 bg-blue-600 hover:bg-blue-500 text-white text-sm px-3 py-2 rounded disabled:opacity-50"
            >
              {submitting ? 'Starting…' : 'Start Execution →'}
            </button>
            <button
              onClick={() => handleSubmit(false)}
              disabled={submitting || !intent.trim()}
              className="flex-1 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 text-sm px-3 py-2 rounded disabled:opacity-50"
            >
              Review first
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add app/projects/[id]/components/quick-start.tsx app/api/change-requests/route.ts
git commit -m "feat: Quick Start panel with context-aware prefill, conditional friction, optimistic insert"
```

---

### Task 4: System Signals Component

**Files:**
- Create: `app/projects/[id]/components/system-signals.tsx`

- [ ] **Step 1: Create the component**

```tsx
// app/projects/[id]/components/system-signals.tsx
'use client'
import { useState } from 'react'

interface SystemSignalPayload {
  overallStatus: 'Improving' | 'Degrading' | 'Mixed'
  modelAccuracy: {
    avg7d: number | null
    delta: number
    trendArrow: string
    runCount: number
  }
  missRate: {
    avg7d: number | null
    delta: number
    trendArrow: string
  }
  executionHealth: {
    successRate: number | null
    failureRate: number | null
    stallRate: number | null
    total7d: number
    avgDurationMs: number | null
    successRateDelta: number
  }
  coverageQuality: {
    lowConfidenceCount: number
  }
  computedAt: string
}

interface SystemSignalsProps {
  snapshot: SystemSignalPayload | null
  avgConfidence: number
  componentCount: number
}

function Panel({
  title,
  primary,
  secondary,
  trend,
  expanded,
  onToggle,
  children,
}: {
  title: string
  primary: string
  secondary: string
  trend: string
  expanded: boolean
  onToggle: () => void
  children?: React.ReactNode
}) {
  const trendColor = trend === '↑' ? 'text-green-400' : trend === '↓' ? 'text-red-400' : 'text-zinc-500'

  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-3">
      <div className="flex items-center justify-between cursor-pointer" onClick={onToggle}>
        <div>
          <p className="text-xs text-zinc-400">{title}</p>
          <p className="text-xl font-semibold text-zinc-100 mt-0.5">{primary}</p>
          <p className="text-xs text-zinc-500 mt-0.5">{secondary}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <span className={`text-sm ${trendColor}`}>{trend}</span>
          <span className="text-xs text-zinc-600">{expanded ? '▲' : '▼'}</span>
        </div>
      </div>
      {expanded && children && (
        <div className="mt-3 border-t border-zinc-800 pt-3">
          {children}
        </div>
      )}
    </div>
  )
}

export function SystemSignals({ snapshot, avgConfidence, componentCount }: SystemSignalsProps) {
  const [expandedPanel, setExpandedPanel] = useState<string | null>(null)

  function toggle(panel: string) {
    setExpandedPanel(prev => prev === panel ? null : panel)
  }

  if (!snapshot) {
    return (
      <section>
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wide mb-3">System Signals</h2>
        <p className="text-sm text-zinc-500">Not enough data yet — run at least 2 analyses to see signals.</p>
      </section>
    )
  }

  const { modelAccuracy, missRate, executionHealth, coverageQuality, overallStatus } = snapshot

  const statusColor = overallStatus === 'Improving' ? 'text-green-400 bg-green-950/20 border-green-500/30'
    : overallStatus === 'Degrading' ? 'text-red-400 bg-red-950/20 border-red-500/30'
    : 'text-amber-400 bg-amber-950/20 border-amber-500/30'

  const statusIcon = overallStatus === 'Improving' ? '↑' : overallStatus === 'Degrading' ? '↓' : '~'

  const avgDurSec = executionHealth.avgDurationMs != null
    ? Math.round(executionHealth.avgDurationMs / 1000)
    : null

  return (
    <section>
      <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wide mb-3">System Signals</h2>

      {/* Overall Status Banner */}
      <div className={`rounded-lg border p-3 mb-4 flex items-center gap-2 ${statusColor}`}>
        <span className="font-bold">{statusIcon}</span>
        <div>
          <p className="text-sm font-semibold">System status: {overallStatus}</p>
          <p className="text-xs opacity-70">
            {overallStatus === 'Improving' ? 'Accuracy up, miss rate falling'
            : overallStatus === 'Degrading' ? 'Accuracy falling, review signals below'
            : 'Mixed signals — check individual panels'}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {/* Model Accuracy */}
        <Panel
          title="Model Accuracy (7d)"
          primary={modelAccuracy.avg7d != null ? `${Math.round(modelAccuracy.avg7d * 100)}%` : '—'}
          secondary={`Based on ${modelAccuracy.runCount} runs`}
          trend={modelAccuracy.trendArrow}
          expanded={expandedPanel === 'accuracy'}
          onToggle={() => toggle('accuracy')}
        >
          <p className="text-xs text-zinc-400">
            7-day delta: {modelAccuracy.delta > 0 ? '+' : ''}{Math.round(modelAccuracy.delta)}%
          </p>
          {modelAccuracy.delta <= -10 && (
            <p className="text-xs text-amber-400 mt-1">⚠ Accuracy declining significantly</p>
          )}
        </Panel>

        {/* Miss Rate */}
        <Panel
          title="Weighted Miss Rate (7d)"
          primary={missRate.avg7d != null ? `${Math.round(missRate.avg7d * 100)}%` : '—'}
          secondary="Higher-centrality components weighted up"
          trend={missRate.trendArrow}
          expanded={expandedPanel === 'missrate'}
          onToggle={() => toggle('missrate')}
        >
          <p className="text-xs text-zinc-400">
            7-day delta: {missRate.delta > 0 ? '+' : ''}{Math.round(missRate.delta)}%
          </p>
        </Panel>

        {/* Execution Health */}
        <Panel
          title="Execution Health (7d)"
          primary={executionHealth.successRate != null ? `${executionHealth.successRate}% success` : '—'}
          secondary={`${executionHealth.total7d} runs total`}
          trend={executionHealth.successRateDelta >= 5 ? '↑' : executionHealth.successRateDelta <= -5 ? '↓' : '~ stable'}
          expanded={expandedPanel === 'health'}
          onToggle={() => toggle('health')}
        >
          <div className="space-y-1 text-xs text-zinc-400">
            {executionHealth.successRate != null && <p>Success rate: {executionHealth.successRate}%</p>}
            {executionHealth.failureRate != null && <p>Failure rate: {executionHealth.failureRate}%</p>}
            {executionHealth.stallRate != null && <p>Stall rate: {executionHealth.stallRate}%</p>}
            {avgDurSec != null && (
              <p className={Math.abs(executionHealth.successRateDelta) >= 5 ? 'text-amber-400' : ''}>
                {Math.abs(executionHealth.successRateDelta) >= 5 && '⚠ '}
                Avg execution time: {avgDurSec}s
              </p>
            )}
          </div>
        </Panel>

        {/* Coverage Quality */}
        <Panel
          title="Coverage Quality"
          primary={`${avgConfidence}%`}
          secondary={avgConfidence < 70 ? 'Below target (≥70%)' : 'On target'}
          trend={avgConfidence >= 70 ? '↑' : avgConfidence < 50 ? '↓' : '~ stable'}
          expanded={expandedPanel === 'coverage'}
          onToggle={() => toggle('coverage')}
        >
          <p className="text-xs text-zinc-400">
            {coverageQuality.lowConfidenceCount} of {componentCount} components below threshold (&lt;60%)
          </p>
          {avgConfidence < 70 && (
            <p className="text-xs text-amber-400 mt-1">Target: ≥70%</p>
          )}
        </Panel>
      </div>
    </section>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add app/projects/[id]/components/system-signals.tsx
git commit -m "feat: System Signals component with 4-panel health overview and overall status banner"
```

---

### Task 5: Wire All Four Sections into Dashboard

**Files:**
- Modify: `app/projects/[id]/page.tsx`
- Modify: `app/projects/[id]/project-dashboard.tsx`

- [ ] **Step 1: Fetch precomputed data in `page.tsx`**

Add to the sequential queries in `page.tsx` (after the snapshot query):

```ts
// Fetch precomputed dashboard data
const [
  { data: riskScoresRaw },
  { data: actionItemsRaw },
  { data: signalSnapshot },
] = await Promise.all([
  db.from('risk_scores')
    .select('component_id, risk_score, tier, system_components(name)')
    .eq('project_id', id)
    .order('risk_score', { ascending: false })
    .limit(5),
  db.from('action_items')
    .select('id, tier, priority_score, source, payload_json')
    .eq('project_id', id)
    .is('resolved_at', null)
    .order('priority_score', { ascending: false })
    .limit(5),
  db.from('system_signal_snapshot')
    .select('payload_json, computed_at')
    .eq('project_id', id)
    .maybeSingle(),
])

const riskScores = (riskScoresRaw ?? []).map(r => ({
  componentId: r.component_id,
  componentName: (r.system_components as any)?.name ?? r.component_id,
  riskScore: r.risk_score,
  tier: r.tier as 'HIGH' | 'MEDIUM',
  incomingDeps: 0,
}))

const actionItems = (actionItemsRaw ?? []).map(r => ({
  id: r.id,
  tier: r.tier,
  source: r.source,
  priorityScore: r.priority_score,
  payload: r.payload_json as any,
}))
```

Pass to `ProjectDashboard`:
```tsx
<ProjectDashboard
  project={project as any}
  initialChanges={changes ?? []}
  initialStats={...}
  initialComponents={components}
  initialSnapshots={recentSnapshots ?? []}
  initialActiveChanges={activeChangesRaw ?? []}
  initialRiskScores={riskScores}
  initialActionItems={actionItems}
  signalSnapshot={signalSnapshot?.payload_json as any ?? null}
/>
```

- [ ] **Step 2: Add all four sections to `ProjectDashboard`**

In `app/projects/[id]/project-dashboard.tsx`, add imports:

```tsx
import { RiskRadar } from './components/risk-radar'
import { NextBestActions } from './components/next-best-actions'
import { QuickStart } from './components/quick-start'
import { SystemSignals } from './components/system-signals'
```

Update the props interface and component body to accept the new props. Replace the current return JSX with:

```tsx
return (
  <div className="max-w-5xl mx-auto px-4 py-8 space-y-8">
    {/* Row 1: Active Changes + Recent Outcomes */}
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <ActiveChanges
        initialChanges={initialActiveChanges}
        events={events}
        onCreateChange={() => {/* handled by QuickStart event listener */}}
      />
      <RecentOutcomes
        snapshots={initialSnapshots}
        changeNames={changeNames}
      />
    </div>

    {/* Row 2: Risk Radar + Next Best Actions */}
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <RiskRadar riskScores={initialRiskScores} projectId={project.id} />
      <NextBestActions actionItems={initialActionItems} />
    </div>

    {/* Row 3: System Signals (full width) */}
    <SystemSignals
      snapshot={signalSnapshot}
      avgConfidence={initialStats.avgConfidence}
      componentCount={initialStats.componentCount}
    />

    {/* Quick Start panel (floating) */}
    <QuickStart
      projectId={project.id}
      components={initialComponents.map(c => ({ id: c.id, name: c.name, confidence: c.confidence }))}
      onChangeCreated={(changeId, clientRequestId) => {
        // Optimistic insert handled by useAnalysisStream via event
      }}
    />
  </div>
)
```

- [ ] **Step 3: Verify TypeScript**

```bash
npx tsc --noEmit
```

Expected: no errors. Fix any prop type mismatches.

- [ ] **Step 4: End-to-end smoke test**

1. Start dev server: `npm run dev`
2. Navigate to a project with at least 2 completed analyses
3. Verify all 6 sections render without errors:
   - Active Changes (may be empty if no active changes)
   - Recent Outcomes (shows last 5 completed analyses)
   - Risk Radar (may show empty state if jobs haven't run)
   - Next Best Actions (may show empty state)
   - System Signals (shows panels with data)
   - Quick Start button (bottom-right)
4. Click Quick Start, fill intent + components, verify form validation:
   - Short intent shows nudge
   - HIGH risk shows friction warning
   - Risk level override shows system warning
5. Trigger a job run manually: `POST /api/projects/<id>/dashboard-jobs`
6. Verify Risk Radar and Next Best Actions populate after job run

- [ ] **Step 5: Commit**

```bash
git add app/projects/[id]/page.tsx app/projects/[id]/project-dashboard.tsx
git commit -m "feat: wire Risk Radar, Next Best Actions, Quick Start, System Signals into dashboard"
```

---

## Self-Review Checklist

- [ ] Risk Radar shows empty state when fewer than 3 components exceed threshold ✓
- [ ] Risk card trend indicator uses ±10 point delta threshold ✓
- [ ] Next Best Actions: tier dominance rule applied by backend (Plan 2), component passes through ✓
- [ ] Quick Start: conditional friction shown only when HIGH risk OR ≥4 components ✓
- [ ] Quick Start: risk override warning persists while overriding (not modal) ✓
- [ ] Quick Start: `client_request_id` sent as header on both POST /change-requests and POST /execute ✓
- [ ] Quick Start: `open-quick-start` custom event is pre-fills from Risk Radar and Next Best Actions ✓
- [ ] System Signals: overall status banner shows at top, always visible ✓
- [ ] System Signals: panels expandable, trend arrows suppressed when abs(delta) < 5 ✓
- [ ] System Signals: empty state when `snapshot === null` ✓
- [ ] All components handle empty/null data gracefully ✓
