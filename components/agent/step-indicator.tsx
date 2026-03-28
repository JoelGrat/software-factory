const ALL_STEPS = [
  { label: 'Vision',       icon: 'auto_awesome' },
  { label: 'Requirement',  icon: 'edit_note' },
  { label: 'Plan',         icon: 'architecture' },
  { label: 'Execution',    icon: 'terminal' },
  { label: 'Review',       icon: 'rate_review' },
]

interface Props {
  current: 1 | 2 | 3 | 4 | 5
  /** Skip the Vision step (future imported projects). */
  skipVision?: boolean
}

export function StepIndicator({ current, skipVision = false }: Props) {
  const steps = skipVision ? ALL_STEPS.slice(1) : ALL_STEPS

  return (
    <div className="bg-[#0b1326]/80 backdrop-blur-md border-b border-white/5 -mx-10 px-10 py-6 mb-10">
      <div className="max-w-4xl mx-auto flex items-center justify-between relative">
        {/* Connector background */}
        <div className="absolute top-5 left-0 w-full h-0.5 bg-surface-container-highest z-0" />
        {/* Connector filled */}
        <div
          className="absolute top-5 left-0 h-0.5 bg-indigo-500 z-0 transition-all duration-500"
          style={{ width: `${((current - 1) / (steps.length - 1)) * 100}%` }}
        />
        {steps.map((step, i) => {
          const num = i + 1
          const done   = num < current
          const active = num === current
          return (
            <div key={step.label} className="relative z-10 flex flex-col items-center gap-2">
              <div className={[
                'w-10 h-10 rounded-full flex items-center justify-center border-4 border-[#0b1326] transition-all',
                active
                  ? 'bg-indigo-500 ring-2 ring-indigo-500/30 shadow-[0_0_16px_rgba(99,102,241,0.4)]'
                  : done
                    ? 'bg-primary'
                    : 'bg-surface-container-high',
              ].join(' ')}>
                {done
                  ? <span className="material-symbols-outlined text-on-primary" style={{ fontSize: '16px' }}>check</span>
                  : <span
                      className={`material-symbols-outlined ${active ? 'text-white' : 'text-slate-500'}`}
                      style={{ fontSize: '16px' }}
                    >
                      {step.icon}
                    </span>
                }
              </div>
              <span className={[
                'text-[10px] font-bold uppercase tracking-tighter font-headline',
                active ? 'text-indigo-400' : done ? 'text-on-surface-variant' : 'text-slate-500',
              ].join(' ')}>
                {step.label}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
