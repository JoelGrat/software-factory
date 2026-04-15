'use client'
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import type { DashboardEvent } from '@/lib/dashboard/event-types'

interface ChangeCard {
  id: string
  title: string
  status: string
  analysisStatus: string
  pipelineStatus: string
  risk_level: string
  updated_at: string
}

interface ActiveChangesProps {
  projectId: string
  initialChanges: ChangeCard[]
  events: DashboardEvent[]
  onCreateChange: () => void
}

// ── Relative time ─────────────────────────────────────────────────────────────

function useRelativeTime(isoDate: string) {
  const [label, setLabel] = useState(() => relativeTime(isoDate))
  useEffect(() => {
    const id = setInterval(() => setLabel(relativeTime(isoDate)), 5000)
    return () => clearInterval(id)
  }, [isoDate])
  return label
}

function relativeTime(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime()
  const secs = Math.floor(diffMs / 1000)
  if (secs < 60) return `${secs}s ago`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m ago`
  return `${Math.floor(mins / 60)}h ago`
}

// ── Spinner ───────────────────────────────────────────────────────────────────

function Spinner({ size = 14 }: { size?: number }) {
  return (
    <span
      className="material-symbols-outlined animate-spin text-zinc-400"
      style={{ fontSize: size }}
    >
      progress_activity
    </span>
  )
}

// ── Stage derivation ──────────────────────────────────────────────────────────

type CardPhase =
  | 'initializing'
  | 'queued'
  | 'analyzing'
  | 'planning'
  | 'planned'
  | 'awaiting_approval'
  | 'executing'
  | 'stalled'
  | 'failed'
  | 'success'

interface CardState {
  phase: CardPhase
  statusLine: string
  subLine: string | null
  pct: number | null
  iterationLabel: string | null
}

const ANALYZING_STAGE_LABELS: Record<string, string> = {
  analyzing_mapping: 'Parsing repository…',
  analyzing_propagation: 'Building dependency graph…',
  analyzing_scoring: 'Computing risk score…',
  analyzed: 'Impact analysis complete',
  planning: 'Generating plan…',
}

const PIPELINE_STATUS_LABELS: Record<string, string> = {
  spec_generating:  'Generating specification…',
  spec_generated:   'Specification ready…',
  plan_generating:  'Building execution plan…',
  plan_generated:   'Plan generated…',
  impact_analyzing: 'Analyzing impact…',
  impact_analyzed:  'Impact analyzed…',
  scoring:          'Scoring risk…',
  scored:           'Risk scored…',
}

const EXEC_STAGE_LABELS: Record<string, string> = {
  context_load: 'Loading context',
  impact_analysis: 'Analyzing impact',
  patch_generation: 'Generating patches',
  type_check: 'Type checking',
  test_run: 'Running tests',
}

function getCardState(change: ChangeCard, events: DashboardEvent[]): CardState {
  const changeEvents = events
    .filter(e => e.changeId === change.id)
    .sort((a, b) => a.version - b.version)
  const latest = changeEvents[changeEvents.length - 1]

  // Terminal states from DB status
  if (change.status === 'awaiting_approval') {
    const risk = change.risk_level ? change.risk_level.toUpperCase() : null
    return {
      phase: 'awaiting_approval',
      statusLine: 'Plan ready — approval required',
      subLine: risk ? `Risk: ${risk}` : null,
      pct: null,
      iterationLabel: null,
    }
  }
  if (change.status === 'planned') {
    return { phase: 'planned', statusLine: 'Plan ready — manual start required', subLine: null, pct: null, iterationLabel: null }
  }
  if ((change.status === 'failed' || change.pipelineStatus?.startsWith('failed_at_')) && !latest) {
    const failedPhase = change.pipelineStatus?.startsWith('failed_at_')
      ? change.pipelineStatus.replace('failed_at_', '').replace(/_/g, ' ')
      : ''
    return { phase: 'failed', statusLine: failedPhase ? `Failed — ${failedPhase}` : 'Execution failed', subLine: null, pct: null, iterationLabel: null }
  }

  // Analysing statuses driven by DB (before events arrive)
  if (['analyzing_mapping', 'analyzing_propagation', 'analyzing_scoring', 'analyzed', 'planning'].includes(change.status) && !latest) {
    return {
      phase: 'analyzing',
      statusLine: ANALYZING_STAGE_LABELS[change.status] ?? 'Analyzing…',
      subLine: null,
      pct: null,
      iterationLabel: null,
    }
  }

  // Pipeline in-progress statuses (no events yet — new pipeline path)
  if (!latest && PIPELINE_STATUS_LABELS[change.pipelineStatus]) {
    return {
      phase: 'analyzing',
      statusLine: PIPELINE_STATUS_LABELS[change.pipelineStatus],
      subLine: null,
      pct: null,
      iterationLabel: null,
    }
  }

  // No events yet
  if (!latest) {
    return { phase: 'queued', statusLine: 'Queued — waiting for runner', subLine: null, pct: null, iterationLabel: null }
  }

  switch (latest.type) {
    case 'queued':
      return { phase: 'queued', statusLine: 'Queued — waiting for runner', subLine: null, pct: null, iterationLabel: null }

    case 'started':
      return { phase: 'analyzing', statusLine: 'Analyzing…', subLine: null, pct: 0, iterationLabel: null }

    case 'progress': {
      const p = latest.payload as { stage?: string; pct?: number; iteration?: number; maxIterations?: number }
      const isExec = p.stage?.startsWith('iteration_') || p.stage === 'patch_generation' || p.stage === 'type_check' || p.stage === 'test_run'
      const phase: CardPhase = isExec ? 'executing' : 'analyzing'
      const stageLabel = isExec
        ? (EXEC_STAGE_LABELS[p.stage ?? ''] ?? 'Executing…')
        : (ANALYZING_STAGE_LABELS[p.stage ?? ''] ?? 'Analyzing…')
      const iterMatch = p.stage?.match(/^iteration_(\d+)$/)
      const iterLabel = iterMatch && p.maxIterations ? `Iteration ${iterMatch[1]}/${p.maxIterations}` : null
      return {
        phase,
        statusLine: phase === 'executing' ? 'Executing…' : 'Analyzing…',
        subLine: stageLabel,
        pct: p.pct ?? null,
        iterationLabel: iterLabel,
      }
    }

    case 'stalled': {
      const p = latest.payload as { minutesSinceProgress?: number }
      const mins = p.minutesSinceProgress ?? null
      return {
        phase: 'stalled',
        statusLine: `Stalled — no progress${mins ? ` for ${mins} minutes` : ''}`,
        subLine: null,
        pct: null,
        iterationLabel: null,
      }
    }

    case 'completed': {
      const p = latest.payload as { outcome?: string }
      const success = p.outcome === 'success'
      return {
        phase: success ? 'success' : 'failed',
        statusLine: success ? 'Applied successfully' : 'Execution failed',
        subLine: null,
        pct: 100,
        iterationLabel: null,
      }
    }

    default:
      return { phase: 'queued', statusLine: 'Initializing…', subLine: null, pct: null, iterationLabel: null }
  }
}

// ── Card ──────────────────────────────────────────────────────────────────────

function ChangeCardItem({
  change,
  projectId,
  events,
}: {
  change: ChangeCard
  projectId: string
  events: DashboardEvent[]
}) {
  const router = useRouter()
  const [approving, setApproving] = useState(false)
  const [approveError, setApproveError] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)
  const [dismissing, setDismissing] = useState(false)
  const ago = useRelativeTime(change.updated_at)
  const state = getCardState(change, events)

  const borderClass = {
    initializing: 'border-zinc-700 bg-zinc-900',
    queued:       'border-zinc-700 bg-zinc-900',
    analyzing:    'border-indigo-500/30 bg-indigo-950/10',
    planning:     'border-indigo-500/30 bg-indigo-950/10',
    planned:      'border-zinc-600 bg-zinc-900',
    awaiting_approval: 'border-blue-500/40 bg-blue-950/20',
    executing:    'border-indigo-500/30 bg-indigo-950/10',
    stalled:      'border-amber-500/40 bg-amber-950/20',
    failed:       'border-red-500/30 bg-red-950/10',
    success:      'border-green-500/30 bg-green-950/10',
  }[state.phase]

  const hoverClass = {
    initializing: 'hover:border-zinc-500 hover:bg-zinc-800',
    queued:       'hover:border-zinc-500 hover:bg-zinc-800',
    analyzing:    'hover:border-indigo-400/50',
    planning:     'hover:border-indigo-400/50',
    planned:      'hover:border-zinc-500 hover:bg-zinc-800',
    awaiting_approval: 'hover:border-blue-400/60',
    executing:    'hover:border-indigo-400/50',
    stalled:      'hover:border-amber-400/60',
    failed:       'hover:border-red-400/50',
    success:      'hover:border-green-400/50',
  }[state.phase]

  const statusColor = {
    initializing: 'text-zinc-500',
    queued:       'text-zinc-400',
    analyzing:    'text-indigo-400',
    planning:     'text-indigo-400',
    planned:      'text-zinc-400',
    awaiting_approval: 'text-blue-400',
    executing:    'text-indigo-400',
    stalled:      'text-amber-400',
    failed:       'text-red-400',
    success:      'text-green-400',
  }[state.phase]

  async function handleApprove() {
    setApproving(true)
    setApproveError(null)
    try {
      const res = await fetch(`/api/change-requests/${change.id}/approve-execution`, { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setApproveError(data.detail ?? data.error ?? 'Something went wrong')
        return
      }
      router.refresh()
    } finally {
      setApproving(false)
    }
  }

  async function handleRetry() {
    setRetrying(true)
    try {
      await fetch(`/api/change-requests/${change.id}/analyze`, { method: 'POST' })
      router.refresh()
    } finally {
      setRetrying(false)
    }
  }

  async function handleDismiss() {
    setDismissing(true)
    try {
      await fetch(`/api/change-requests/${change.id}/dismiss`, { method: 'POST' })
      router.refresh()
    } finally {
      setDismissing(false)
    }
  }

  const isInProgress = ['queued', 'analyzing', 'planning', 'executing'].includes(state.phase)
  const showPulse = ['queued', 'initializing'].includes(state.phase)

  return (
    <div
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('[data-action]')) return
        const dest = change.status === 'executing'
          ? `/projects/${projectId}/changes/${change.id}/execution`
          : `/projects/${projectId}/changes/${change.id}`
        router.push(dest)
      }}
      className={`rounded-lg border p-3 text-sm cursor-pointer transition-all ${borderClass} ${hoverClass}`}
    >
      {/* Title row */}
      <div className="flex items-start justify-between gap-3">
        <span className="font-medium text-zinc-100 leading-snug">{change.title}</span>
        <div className="flex items-center gap-1.5 flex-shrink-0 mt-0.5">
          {isInProgress && <Spinner size={13} />}
          {showPulse && <span className="w-1.5 h-1.5 rounded-full bg-zinc-500 animate-pulse" />}
          <span className={`text-xs font-medium ${statusColor}`}>{state.statusLine}</span>
        </div>
      </div>

      {/* Sub-line (stage detail) */}
      {state.subLine && (
        <p className="mt-1 text-xs text-zinc-500">{state.subLine}</p>
      )}

      {/* Iteration label */}
      {state.iterationLabel && (
        <p className="mt-0.5 text-xs text-indigo-400/70">{state.iterationLabel}</p>
      )}

      {/* Progress bar */}
      {state.pct != null && state.phase !== 'success' && state.phase !== 'failed' && (
        <div className="mt-2 h-1 rounded-full bg-zinc-700 overflow-hidden">
          <div
            className="h-full bg-indigo-500 transition-all duration-700"
            style={{ width: `${state.pct}%` }}
          />
        </div>
      )}

      {/* Queued: timestamp + cancel */}
      {state.phase === 'queued' && (
        <div className="mt-2 flex items-center justify-between">
          <span className="text-xs text-zinc-600">{ago}</span>
          <button
            data-action
            onClick={() => router.push(`/projects/${projectId}/changes/${change.id}`)}
            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Awaiting approval: primary actions */}
      {state.phase === 'awaiting_approval' && (
        <div className="mt-3 space-y-2">
          <div className="flex gap-2">
            <button
              data-action
              onClick={handleApprove}
              disabled={approving}
              className="flex-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-xs font-semibold px-3 py-1.5 rounded transition-colors"
            >
              {approving ? 'Starting…' : 'Approve & Execute'}
            </button>
            <button
              data-action
              onClick={() => router.push(`/projects/${projectId}/changes/${change.id}`)}
              className="text-xs text-zinc-400 hover:text-zinc-200 px-3 py-1.5 rounded border border-zinc-700 hover:border-zinc-500 transition-colors"
            >
              Review Plan
            </button>
          </div>
          {approveError && (
            <p data-action className="text-xs text-red-400 leading-snug">{approveError}</p>
          )}
        </div>
      )}

      {/* Planned (manual): go to detail */}
      {state.phase === 'planned' && (
        <div className="mt-2">
          <button
            data-action
            onClick={() => router.push(`/projects/${projectId}/changes/${change.id}`)}
            className="text-xs text-zinc-400 hover:text-zinc-200 underline transition-colors"
          >
            Open change to start execution →
          </button>
        </div>
      )}

      {/* Stalled: retry + view details */}
      {state.phase === 'stalled' && (
        <div className="mt-3 flex gap-2">
          <button
            data-action
            onClick={handleRetry}
            disabled={retrying}
            className="flex-1 bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-white text-xs font-semibold px-3 py-1.5 rounded transition-colors"
          >
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
          <button
            data-action
            onClick={() => router.push(`/projects/${projectId}/changes/${change.id}`)}
            className="text-xs text-zinc-400 hover:text-zinc-200 px-3 py-1.5 rounded border border-zinc-700 hover:border-zinc-500 transition-colors"
          >
            View Details
          </button>
        </div>
      )}

      {/* Failed: retry analysis + dismiss */}
      {state.phase === 'failed' && (
        <div className="mt-3 flex gap-2">
          <button
            data-action
            onClick={handleRetry}
            disabled={retrying}
            className="flex-1 bg-zinc-700 hover:bg-zinc-600 disabled:opacity-50 text-zinc-200 text-xs font-semibold px-3 py-1.5 rounded transition-colors"
          >
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
          <button
            data-action
            onClick={() => router.push(`/projects/${projectId}/changes/${change.id}`)}
            className="text-xs text-zinc-400 hover:text-zinc-200 px-3 py-1.5 rounded border border-zinc-700 hover:border-zinc-500 transition-colors"
          >
            Details
          </button>
          <button
            data-action
            onClick={handleDismiss}
            disabled={dismissing}
            className="text-xs text-zinc-500 hover:text-zinc-300 disabled:opacity-50 px-2 py-1.5 transition-colors"
            title="Remove from active list"
          >
            {dismissing ? '…' : '✕'}
          </button>
        </div>
      )}

      {/* Success */}
      {state.phase === 'success' && (
        <div className="mt-2 flex items-center gap-1.5">
          <span className="material-symbols-outlined text-green-400" style={{ fontSize: 14 }}>check_circle</span>
          <span className="text-xs text-green-400">Ready for review</span>
        </div>
      )}
    </div>
  )
}

// ── Section ───────────────────────────────────────────────────────────────────

export function ActiveChanges({ projectId, initialChanges, events, onCreateChange }: ActiveChangesProps) {
  const [optimisticCards] = useState<ChangeCard[]>([])
  const allChanges = [...optimisticCards, ...initialChanges]

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wide">Active Changes</h2>
        <button onClick={onCreateChange} className="text-xs text-blue-400 hover:text-blue-300">
          + New Change
        </button>
      </div>

      {allChanges.length === 0 ? (
        <p className="text-sm text-zinc-500">No active changes — start one above.</p>
      ) : (
        <div className="space-y-2">
          {allChanges.map(change => (
            <ChangeCardItem
              key={change.id}
              change={change}
              projectId={projectId}
              events={events}
            />
          ))}
        </div>
      )}
    </section>
  )
}
