'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
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
  projectId: string
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

export function ActiveChanges({ projectId, initialChanges, events, onCreateChange }: ActiveChangesProps) {
  const router = useRouter()
  const [optimisticCards] = useState<ChangeCard[]>([])

  const allChanges = [...optimisticCards, ...initialChanges]

  if (allChanges.length === 0) {
    return (
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wide">Active Changes</h2>
          <button onClick={onCreateChange} className="text-xs text-blue-400 hover:text-blue-300">
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
              onClick={(e) => {
                if ((e.target as HTMLElement).closest('[data-action]')) return
                router.push(`/projects/${projectId}/changes/${change.id}`)
              }}
              className={`rounded-lg border p-3 text-sm cursor-pointer transition-all ${
                isStalled
                  ? 'border-amber-500/40 bg-amber-950/20 hover:border-amber-400/60 hover:bg-amber-950/30'
                  : isCompleted && state.outcome === 'success'
                  ? 'border-green-500/30 bg-green-950/10 hover:border-green-400/50 hover:bg-green-950/20'
                  : isCompleted
                  ? 'border-red-500/30 bg-red-950/10 hover:border-red-400/50 hover:bg-red-950/20'
                  : 'border-zinc-700 bg-zinc-900 hover:border-zinc-500 hover:bg-zinc-800'
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium text-zinc-100 truncate">{change.title}</span>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {canEdit && (
                    <button
                      data-action
                      onClick={() => {
                        window.dispatchEvent(new CustomEvent('open-quick-start', {
                          detail: { intent: change.title },
                        }))
                      }}
                      className="text-xs text-zinc-400 hover:text-zinc-200 px-2 py-0.5 rounded border border-zinc-700 hover:border-zinc-500 transition-colors"
                    >
                      Edit
                    </button>
                  )}
                  <span className={`text-xs font-medium ${
                    isStalled ? 'text-amber-400'
                    : isCompleted && state.outcome === 'success' ? 'text-green-400'
                    : isCompleted ? 'text-red-400'
                    : 'text-zinc-500'
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
