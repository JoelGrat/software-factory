import React from 'react'
import Link from 'next/link'

const STEPS = [
  { key: 'plan',      label: 'Plan',      icon: 'edit_note',  suffix: '',           lockReason: null },
  { key: 'execution', label: 'Execution', icon: 'play_arrow', suffix: '/execution', lockReason: 'Approve the plan before running execution' },
  { key: 'review',    label: 'Review',    icon: 'task_alt',   suffix: '/review',    lockReason: 'Execution must complete before review' },
] as const

type Step = typeof STEPS[number]['key']

/** Where the change actually is in the pipeline right now. */
function pipelineStepIndex(changeStatus: string): number {
  if (['review', 'done'].includes(changeStatus)) return 2
  if (['awaiting_approval', 'planned', 'executing', 'failed'].includes(changeStatus)) return 1
  return 0
}

/** Highest step index the change has ever reached — determines what is unlocked. */
function maxReachedIndex(changeStatus: string): number {
  // same thresholds: once execution is reached it stays reachable
  return pipelineStepIndex(changeStatus)
}

export function ChangeStepBar({
  projectId,
  changeId,
  current,
  changeStatus,
}: {
  projectId: string
  changeId: string
  current: Step
  changeStatus: string
}) {
  const base = `/projects/${projectId}/changes/${changeId}`
  const currentIndex = STEPS.findIndex(s => s.key === current)
  const pipelineIndex = pipelineStepIndex(changeStatus)
  const maxIndex = maxReachedIndex(changeStatus)

  return (
    <div className="flex items-center w-full py-1 mb-1">
      {STEPS.map((step, i) => {
        const isPipeline = i === pipelineIndex   // where the work is happening
        const isViewing  = i === currentIndex    // the page you're looking at
        const isLocked   = i > maxIndex
        const isCompleted = i < pipelineIndex

        // Visual state drives node appearance
        const nodeState: 'completed' | 'pipeline' | 'reachable' | 'locked' =
          isCompleted ? 'completed'
          : isPipeline ? 'pipeline'
          : isLocked   ? 'locked'
          : 'reachable'

        const connectorLit = i > 0 && i - 1 < pipelineIndex

        // A step is "lit" if it's the pipeline step OR the page you're currently viewing
        const isLit = isPipeline || isViewing

        const nodeClass = `w-12 h-12 rounded-2xl flex items-center justify-center border transition-all duration-200 ${
          isViewing
            ? 'bg-indigo-500/20 border-indigo-400/50 shadow-[0_0_22px_rgba(99,102,241,0.22)]'
            : nodeState === 'completed'
            ? 'bg-indigo-500/15 border-indigo-500/35 group-hover:bg-indigo-500/22 group-hover:border-indigo-400/50'
            : isPipeline
            ? 'bg-indigo-500/20 border-indigo-400/50 shadow-[0_0_22px_rgba(99,102,241,0.22)]'
            : nodeState === 'reachable'
            ? 'bg-white/[0.03] border-white/[0.10] group-hover:border-white/[0.18] group-hover:bg-white/[0.05]'
            : 'bg-white/[0.02] border-white/[0.06]'
        }`

        const iconClass = `material-symbols-outlined transition-colors duration-200 ${
          isViewing ? 'text-indigo-300'
          : nodeState === 'completed' ? 'text-indigo-400'
          : isPipeline ? 'text-indigo-300'
          : nodeState === 'reachable' ? 'text-slate-500 group-hover:text-slate-300'
          : 'text-slate-700'
        }`

        const labelClass = `text-[10px] font-bold uppercase tracking-widest font-headline transition-colors duration-200 ${
          isViewing ? 'text-slate-200'
          : nodeState === 'completed' ? 'text-indigo-400/70'
          : isPipeline ? 'text-indigo-400/70'
          : nodeState === 'reachable' ? 'text-slate-500 group-hover:text-slate-300'
          : 'text-slate-700'
        }`

        const inner = (
          <div className="flex flex-col items-center gap-2">
            <div className={nodeClass}>
              <span
                className={iconClass}
                style={{
                  fontSize: '22px',
                  fontVariationSettings: nodeState === 'completed' ? "'wght' 300" : "'wght' 200",
                }}
              >
                {nodeState === 'completed' ? 'check' : step.icon}
              </span>
            </div>
            <span className={labelClass}>{step.label}</span>
          </div>
        )

        return (
          <React.Fragment key={step.key}>
            {i > 0 && (
              <div
                className={`flex-1 h-px mx-4 transition-colors duration-300 ${
                  connectorLit ? 'bg-indigo-400/35' : 'bg-white/[0.06]'
                }`}
              />
            )}

            {isLocked ? (
              <div
                className="flex-shrink-0 cursor-default relative group/locked"
              >
                {inner}
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-3 pointer-events-none opacity-0 group-hover/locked:opacity-100 transition-opacity duration-150 z-50">
                  <div className="flex items-center gap-1.5 bg-[#151e33] border border-white/10 rounded-lg px-3 py-2 shadow-xl whitespace-nowrap">
                    <span className="material-symbols-outlined text-slate-600" style={{ fontSize: '12px' }}>lock</span>
                    <span className="text-[11px] text-slate-500 font-mono">{step.lockReason}</span>
                  </div>
                  <div className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-l-transparent border-r-transparent border-t-white/10" />
                </div>
              </div>
            ) : isPipeline && isViewing ? (
              // On the pipeline step's own page — no link needed
              <div className="flex-shrink-0">
                {inner}
              </div>
            ) : (
              <Link
                href={`${base}${step.suffix}`}
                className="flex-shrink-0 group transition-all"
              >
                {inner}
              </Link>
            )}
          </React.Fragment>
        )
      })}
    </div>
  )
}
