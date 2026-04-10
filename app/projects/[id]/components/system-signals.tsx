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
