// components/app/execution-live-strip.tsx
'use client'

type Phase = 'implementing' | 'static_validation' | 'unit' | 'integration' | 'smoke' | 'repair_inline' | 'repair_phase' | 'committing' | 'idle'

interface LiveEvent {
  event_type: string
  phase?: string
  payload?: Record<string, unknown>
  created_at: string
}

function deriveCurrentPhase(events: LiveEvent[]): { phase: Phase; detail: string } {
  if (events.length === 0) return { phase: 'idle', detail: '' }

  // Walk events in reverse to find the most recent started event without a corresponding ended
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    const t = e.event_type
    if (t === 'execution.completed' || t === 'execution.cancelled' || t === 'execution.budget_exceeded' || t === 'execution.blocked') {
      return { phase: 'idle', detail: '' }
    }
    if (t === 'commit.green' || t === 'commit.wip' || t === 'commit.skipped') {
      return { phase: 'committing', detail: 'Finishing up…' }
    }
    if (t === 'repair.phase.started') return { phase: 'repair_phase', detail: 'Analyzing failure patterns…' }
    if (t === 'repair.inline.started') return { phase: 'repair_inline', detail: 'Patching type errors…' }
    if (t === 'phase.smoke.started') return { phase: 'smoke', detail: 'Running smoke checks…' }
    if (t === 'phase.integration.started') return { phase: 'integration', detail: 'Running integration tests…' }
    if (t === 'phase.unit.started') return { phase: 'unit', detail: 'Running unit tests…' }
    if (t === 'phase.static_validation.started') return { phase: 'static_validation', detail: 'Checking types and lint…' }
    if (t === 'iteration.started') return { phase: 'implementing', detail: 'Implementing changes…' }
  }
  return { phase: 'implementing', detail: 'Starting…' }
}

const SLOTS: { phase: Phase; label: string; icon: string }[] = [
  { phase: 'implementing',      label: 'Implementing',       icon: 'code'           },
  { phase: 'static_validation', label: 'Static validation',  icon: 'check_circle'   },
  { phase: 'unit',              label: 'Unit tests',         icon: 'science'        },
  { phase: 'integration',       label: 'Integration',        icon: 'link'           },
  { phase: 'smoke',             label: 'Smoke checks',       icon: 'bolt'           },
]

const REPAIR_PHASES: Phase[] = ['repair_inline', 'repair_phase']

interface Props {
  events: LiveEvent[]
  runActive: boolean
  elapsedMs: number
  cancelState: 'idle' | 'requesting' | 'cancelled' | 'committing' | 'force_failed'
  onCancel: () => void
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  const ss = s % 60
  return `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

export function ExecutionLiveStrip({ events, runActive, elapsedMs, cancelState, onCancel }: Props) {
  const { phase: currentPhase, detail } = deriveCurrentPhase(events)

  const isRepairActive = REPAIR_PHASES.includes(currentPhase)

  function slotState(slotPhase: Phase): 'running' | 'repair' | 'done' | 'queued' {
    const slotIndex = SLOTS.findIndex(s => s.phase === slotPhase)
    let currentIndex = SLOTS.findIndex(s => s.phase === currentPhase)

    if (currentIndex === -1) {
      // repair/commit/idle — find the last phase that was active before the repair/commit
      const phaseEventTypes: Record<string, Phase> = {
        'phase.static_validation.started': 'static_validation',
        'phase.static_validation.passed': 'static_validation',
        'phase.static_validation.failed': 'static_validation',
        'phase.unit.started': 'unit',
        'phase.unit.passed': 'unit',
        'phase.unit.failed': 'unit',
        'phase.integration.started': 'integration',
        'phase.integration.passed': 'integration',
        'phase.integration.failed': 'integration',
        'phase.smoke.started': 'smoke',
        'phase.smoke.passed': 'smoke',
        'phase.smoke.failed': 'smoke',
      }
      for (let i = events.length - 1; i >= 0; i--) {
        const mappedPhase = phaseEventTypes[events[i]!.event_type]
        if (mappedPhase) {
          currentIndex = SLOTS.findIndex(s => s.phase === mappedPhase)
          break
        }
      }
    }

    if (currentIndex === -1) return 'queued'
    if (slotIndex === currentIndex) return isRepairActive ? 'repair' : 'running'
    if (slotIndex < currentIndex) return 'done'
    return 'queued'
  }

  const cancelLabel =
    cancelState === 'requesting' ? 'Cancelling…' :
    cancelState === 'cancelled'  ? 'Cancelled'   :
    cancelState === 'committing' ? 'Cannot cancel — committing' :
    cancelState === 'force_failed' ? 'Force stop failed' :
    'Cancel'

  const cancelDisabled = cancelState !== 'idle'

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`Execution: ${currentPhase}${detail ? ' — ' + detail : ''}`}
      className="w-full rounded-xl bg-[#0f1929] border border-white/[0.06] px-5 py-3 flex items-center gap-4"
    >
      {/* Slots */}
      <div className="flex items-center gap-3 flex-1 min-w-0">
        {SLOTS.map((slot, i) => {
          const state = slotState(slot.phase)
          const dotColor =
            state === 'running' ? 'bg-blue-400 animate-pulse'  :
            state === 'repair'  ? 'bg-yellow-400 animate-pulse' :
            state === 'done'    ? 'bg-green-400'               :
            'bg-white/[0.10]'

          const labelColor =
            state === 'running' ? 'text-blue-300'   :
            state === 'repair'  ? 'text-yellow-300' :
            state === 'done'    ? 'text-green-400'  :
            'text-slate-600'

          const iconColor =
            state === 'running' ? 'text-blue-400'   :
            state === 'repair'  ? 'text-yellow-400' :
            state === 'done'    ? 'text-green-500'  :
            'text-slate-700'

          return (
            <div key={slot.phase} className="flex items-center gap-2 flex-shrink-0">
              {i > 0 && <div className={`w-4 h-px flex-shrink-0 ${state === 'queued' ? 'bg-white/[0.06]' : 'bg-white/[0.15]'}`} />}
              <div className="flex items-center gap-1.5">
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotColor}`} />
                <span className={`material-symbols-outlined ${iconColor}`} style={{ fontSize: '14px' }}>
                  {state === 'done' ? 'check' : slot.icon}
                </span>
                <span className={`text-[11px] font-medium font-headline ${labelColor} hidden sm:block`}>
                  {slot.label}
                </span>
              </div>
            </div>
          )
        })}
      </div>

      {/* Detail subtext */}
      {detail && runActive && (
        <span className="text-[10px] font-mono text-slate-500 truncate hidden md:block flex-shrink min-w-0">
          {detail}
        </span>
      )}

      {/* Elapsed + cancel */}
      {runActive && (
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-[11px] font-mono text-slate-500">{formatElapsed(elapsedMs)}</span>
          <button
            onClick={onCancel}
            disabled={cancelDisabled}
            aria-label={cancelLabel}
            className="px-2.5 py-1 rounded-lg text-[10px] font-bold font-headline uppercase tracking-wider border transition-colors
              disabled:opacity-40 disabled:cursor-not-allowed
              border-white/[0.10] text-slate-400 hover:border-white/[0.20] hover:text-slate-200"
          >
            {cancelLabel}
          </button>
        </div>
      )}
    </div>
  )
}
