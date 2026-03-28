const STEPS = [
  { label: 'Requirement', icon: 'edit_note' },
  { label: 'Plan',        icon: 'architecture' },
  { label: 'Execution',   icon: 'terminal' },
  { label: 'Review',      icon: 'rate_review' },
]

// Progress line fills the connector between completed + active steps
const PROGRESS_WIDTHS: Record<number, string> = {
  1: 'w-0',
  2: 'w-1/3',
  3: 'w-2/3',
  4: 'w-full',
}

export function StepIndicator({ current }: { current: 1 | 2 | 3 | 4 }) {
  return (
    <div className="bg-[#0b1326]/80 backdrop-blur-md border-b border-white/5 -mx-10 px-10 py-6 mb-10">
      <div className="max-w-4xl mx-auto flex items-center justify-between relative">
        {/* Connector background */}
        <div className="absolute top-5 left-0 w-full h-0.5 bg-surface-container-highest z-0" />
        {/* Connector filled */}
        <div className={`absolute top-5 left-0 h-0.5 bg-indigo-500 z-0 transition-all duration-500 ${PROGRESS_WIDTHS[current]}`} />

        {STEPS.map((step, i) => {
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
                  ? <span className="material-symbols-outlined text-on-primary text-[16px]">check</span>
                  : <span className={`material-symbols-outlined text-[16px] ${active ? 'text-white' : 'text-slate-500'}`}>{step.icon}</span>
                }
              </div>
              <span className={`text-[10px] font-bold uppercase tracking-tighter font-headline ${active ? 'text-indigo-400' : done ? 'text-on-surface-variant' : 'text-slate-500'}`}>
                {step.label}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
