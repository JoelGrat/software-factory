// components/app/execution-iteration-card.tsx
'use client'
import { useState } from 'react'

interface IterationEvent {
  event_type: string
  phase?: string
  payload?: Record<string, unknown>
  created_at: string
}

interface Props {
  iteration: number
  events: IterationEvent[]
  defaultExpanded?: boolean
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`
}

function deriveIterationStatus(events: IterationEvent[]): {
  label: string
  color: string
  icon: string
  durationMs: number
} {
  const stuck = events.find(e => e.event_type === 'iteration.stuck')
  const completed = events.find(e => e.event_type === 'iteration.completed')

  if (stuck) return { label: 'Stuck', color: 'text-red-400 bg-red-400/10', icon: 'block', durationMs: 0 }

  if (!completed) return { label: 'Running', color: 'text-blue-400 bg-blue-400/10', icon: 'pending', durationMs: 0 }

  const allPassed =
    events.some(e => e.event_type === 'phase.static_validation.passed') &&
    events.some(e => e.event_type === 'phase.unit.passed')

  const label = allPassed ? 'Passed' : 'Failed'
  const color = allPassed ? 'text-green-400 bg-green-400/10' : 'text-red-400 bg-red-400/10'
  const icon = allPassed ? 'check' : 'close'
  const durationMs = (completed?.payload?.durationMs as number | undefined) ?? 0

  return { label, color, icon, durationMs }
}

export function ExecutionIterationCard({ iteration, events, defaultExpanded = false }: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const { label, color, icon, durationMs } = deriveIterationStatus(events)

  // Extract data from events
  const svFailed = events.find(e => e.event_type === 'phase.static_validation.failed')
  const svPassed = events.find(e => e.event_type === 'phase.static_validation.passed')
  const unitFailed = events.find(e => e.event_type === 'phase.unit.failed')
  const unitPassed = events.find(e => e.event_type === 'phase.unit.passed')
  const inlineRepairs = events.filter(e => e.event_type === 'repair.inline.succeeded' || e.event_type === 'repair.inline.failed')
  const repairPhases = events.filter(e => e.event_type === 'repair.phase.succeeded' || e.event_type === 'repair.phase.failed')
  const skippedPhases = events.filter(e => e.event_type === 'phase.skipped')
  const commitEvent = events.find(e => ['commit.green', 'commit.wip', 'commit.skipped', 'commit.failed'].includes(e.event_type))
  const startedEvent = events.find(e => e.event_type === 'iteration.started')

  const diagnostics = (svFailed?.payload?.diagnostics as any[] | undefined) ?? []
  const diagTotalCount = (svFailed?.payload?.totalCount as number | undefined) ?? diagnostics.length
  const diagTruncated = (svFailed?.payload?.truncated as boolean | undefined) ?? false

  const testDiags = (unitFailed?.payload?.diagnostics as any[] | undefined) ?? []
  const testTotal = (unitFailed?.payload?.totalCount as number | undefined) ?? testDiags.length

  async function copyDiagnostics() {
    const allDiags = { staticValidation: diagnostics, tests: testDiags }
    await navigator.clipboard.writeText(JSON.stringify(allDiags, null, 2))
  }

  return (
    <div className="rounded-xl bg-[#131b2e] border border-white/5 overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="w-full px-5 py-3.5 flex items-center justify-between gap-4 hover:bg-white/[0.02] transition-colors text-left"
      >
        <div className="flex items-center gap-3">
          <span className="material-symbols-outlined text-slate-600" style={{ fontSize: '14px' }}>
            {expanded ? 'expand_less' : 'expand_more'}
          </span>
          <span className="text-sm font-semibold text-slate-300">Iteration {iteration}</span>
          <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded font-mono flex items-center gap-1 ${color}`}>
            <span className="material-symbols-outlined" style={{ fontSize: '10px' }}>{icon}</span>
            {label}
          </span>
        </div>
        <div className="flex items-center gap-3 text-[11px] font-mono text-slate-500">
          {startedEvent && (
            <span title={new Date(startedEvent.created_at).toLocaleString()}>
              {formatTime(startedEvent.created_at)}
            </span>
          )}
          {durationMs > 0 && <span>{formatElapsed(durationMs)}</span>}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-white/5 divide-y divide-white/5">
          {/* Static validation */}
          <div className="px-5 py-3">
            <p className="text-[10px] uppercase tracking-widest text-slate-500 font-headline mb-2">Static Validation</p>
            {svPassed && <p className="text-xs text-green-400 flex items-center gap-1"><span className="material-symbols-outlined" style={{ fontSize: '12px' }}>check</span> Passed</p>}
            {svFailed && (
              <div>
                <p className="text-xs text-red-400 mb-1">{diagTotalCount} error{diagTotalCount !== 1 ? 's' : ''}{diagTruncated ? ` (showing first ${diagnostics.length})` : ''}</p>
                <div className="space-y-0.5">
                  {diagnostics.slice(0, 5).map((d: any, i: number) => (
                    <p key={i} className="text-[10px] font-mono text-slate-500">
                      <span className="text-slate-400">{d.file}:{d.line}</span> {d.message.slice(0, 80)}
                    </p>
                  ))}
                </div>
              </div>
            )}
            {!svPassed && !svFailed && <p className="text-[11px] text-slate-600">—</p>}
          </div>

          {/* Repairs */}
          {(inlineRepairs.length > 0 || repairPhases.length > 0) && (
            <div className="px-5 py-3">
              <p className="text-[10px] uppercase tracking-widest text-slate-500 font-headline mb-2">Repairs</p>
              {inlineRepairs.map((e, i) => {
                const attempt = (e.payload as any)?.attempt
                return (
                  <p key={i} className="text-[10px] font-mono text-slate-400">
                    Inline · {attempt?.confidenceLabel ?? '?'} ({attempt?.confidenceScore?.toFixed(2) ?? '?'}) · {attempt?.rationale ?? ''}
                  </p>
                )
              })}
              {repairPhases.map((e, i) => {
                const attempt = (e.payload as any)?.attempt
                return (
                  <p key={i} className="text-[10px] font-mono text-slate-400 mt-0.5">
                    Repair phase · {attempt?.confidenceLabel ?? '?'} ({attempt?.confidenceScore?.toFixed(2) ?? '?'}) · {attempt?.rationale ?? ''}
                  </p>
                )
              })}
            </div>
          )}

          {/* Tests */}
          <div className="px-5 py-3">
            <p className="text-[10px] uppercase tracking-widest text-slate-500 font-headline mb-2">Tests</p>
            {unitPassed && <p className="text-xs text-green-400 flex items-center gap-1"><span className="material-symbols-outlined" style={{ fontSize: '12px' }}>check</span> Unit passed</p>}
            {unitFailed && <p className="text-xs text-red-400">{testTotal} test failure{testTotal !== 1 ? 's' : ''}</p>}
            {skippedPhases.map((e, i) => (
              <p key={i} className="text-[10px] text-slate-600 font-mono">
                {(e.payload as any)?.phase} — skipped ({(e.payload as any)?.reason})
              </p>
            ))}
            {!unitPassed && !unitFailed && skippedPhases.length === 0 && <p className="text-[11px] text-slate-600">—</p>}
          </div>

          {/* Commit */}
          {commitEvent && (
            <div className="px-5 py-3">
              <p className="text-[10px] uppercase tracking-widest text-slate-500 font-headline mb-2">Commit</p>
              {commitEvent.event_type === 'commit.green' && <p className="text-xs text-green-400">Green commit</p>}
              {commitEvent.event_type === 'commit.wip' && (
                <p className="text-xs text-yellow-400">WIP — {(commitEvent.payload as any)?.reason}</p>
              )}
              {commitEvent.event_type === 'commit.skipped' && (
                <p className="text-xs text-slate-500">Skipped — {(commitEvent.payload as any)?.reason}</p>
              )}
              {commitEvent.event_type === 'commit.failed' && (
                <p className="text-xs text-red-400">Failed — {(commitEvent.payload as any)?.reason}</p>
              )}
            </div>
          )}

          {/* Actions */}
          {(diagnostics.length > 0 || testDiags.length > 0) && (
            <div className="px-5 py-3 flex items-center gap-3">
              <button
                onClick={copyDiagnostics}
                className="text-[10px] font-mono text-slate-500 hover:text-slate-300 transition-colors flex items-center gap-1"
              >
                <span className="material-symbols-outlined" style={{ fontSize: '12px' }}>content_copy</span>
                Copy diagnostics
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
