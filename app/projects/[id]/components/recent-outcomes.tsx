'use client'
import { useState } from 'react'
import type { AnalysisResultSnapshotData } from '@/lib/dashboard/event-types'

interface RecentOutcomesProps {
  snapshots: AnalysisResultSnapshotData[]
  changeNames: Record<string, string>
}

const SEVERITY_THRESHOLDS = { HIGH: 4, MEDIUM: 2 } as const

function getSeverity(snapshot: AnalysisResultSnapshotData): 'HIGH' | 'MEDIUM' | 'LOW' {
  const gapSeverity = (snapshot.modelMiss as any)?.confidence_gap?.actual_severity
  if (gapSeverity) return gapSeverity
  const count = (snapshot.componentsAffected ?? []).length
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
  const failed = (snapshot as any).executionOutcome === 'failure'
  const severity = getSeverity(snapshot)
  const cause = snapshot.failureCause as any
  const parseConfident = cause && (cause.parse_confidence ?? 0) >= 0.9
  const missRate = (snapshot as any).missRate != null
    ? `${Math.round((snapshot as any).missRate * 100)}%`
    : null
  const accuracy = (snapshot as any).jaccardAccuracy != null
    ? `${Math.round((snapshot as any).jaccardAccuracy * 100)}%`
    : null

  const missed: Array<{ name: string }> = (snapshot.modelMiss as any)?.missed ?? []
  const overestimated: Array<{ name: string }> = (snapshot.modelMiss as any)?.overestimated ?? []
  const hasModelData = missed.length > 0 || overestimated.length > 0

  const completedAt = (snapshot as any).completedAt ?? (snapshot as any).completed_at

  return (
    <div className={`rounded-lg border p-3 text-sm ${
      failed ? 'border-red-500/30 bg-red-950/10' : 'border-green-500/30 bg-green-950/10'
    }`}>
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
          {completedAt && <span className="text-zinc-500 text-xs">{formatRelativeTime(completedAt)}</span>}
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

      {failed && (
        <p className="mt-2 text-zinc-300 text-xs">
          {parseConfident && cause
            ? <>Primary cause: <span className="text-red-300">{cause.error_type}</span> → {cause.component_id ?? 'unknown'}</>
            : 'Cause: unclear — see execution log'
          }
        </p>
      )}

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
          {(snapshot.modelMiss as any)?.confidence_gap && (
            <p className="text-xs text-zinc-400">
              <span className="text-zinc-300">Confidence gap:</span>{' '}
              Predicted {(snapshot.modelMiss as any).confidence_gap.predicted}% → Actual:{' '}
              {(snapshot.modelMiss as any).confidence_gap.actual_severity} impact
            </p>
          )}
        </div>
      )}

      <div className="mt-2 flex gap-4 text-xs text-zinc-500">
        {accuracy && <span>Prediction accuracy: {accuracy}</span>}
        {missRate && (
          <span>
            Miss rate: {missRate}
            {missed.length > 0 && (snapshot.componentsAffected ?? []).length > 0 &&
              ` (missed ${missed.length} of ${(snapshot.componentsAffected ?? []).length} affected components)`
            }
          </span>
        )}
        {!failed && <span className="text-green-400/80">Model prediction held — safe to proceed with similar changes</span>}
      </div>

      {(snapshot as any).minimal && (snapshot as any).snapshotStatus === 'pending_enrichment' && (
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
        {visible.map((s, i) => (
          <OutcomeCard
            key={(s as any).changeId ?? i}
            snapshot={s}
            title={changeNames[(s as any).changeId] ?? 'Change'}
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
