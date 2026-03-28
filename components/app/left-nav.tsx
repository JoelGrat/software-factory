'use client'
import Link from 'next/link'

const FOOTER_ITEMS = [
  { href: '/settings', icon: 'settings',     label: 'Settings' },
  { href: 'https://docs.softwarefactory.dev', icon: 'menu_book', label: 'Docs' },
  { href: '/support',  icon: 'help_outline',  label: 'Support' },
]

interface Props {
  projectName?: string
}

export function LeftNav({ projectName }: Props) {
  return (
    <aside className="h-full w-64 flex-shrink-0 flex flex-col bg-[#131b2e] border-r border-white/5 font-headline text-sm font-medium">
      {/* Header — project name when in project context, app brand otherwise */}
      <div className="flex items-center gap-3 px-4 h-16 border-b border-white/5 flex-shrink-0">
        <div className="w-8 h-8 rounded-lg bg-indigo-500/20 flex items-center justify-center flex-shrink-0">
          <span className="material-symbols-outlined text-indigo-400" style={{ fontSize: '18px' }}>
            precision_manufacturing
          </span>
        </div>
        {projectName ? (
          <div className="min-w-0">
            <div className="text-slate-200 font-bold tracking-tight truncate text-sm">{projectName}</div>
            <div className="text-[10px] text-slate-500 uppercase tracking-widest">Project</div>
          </div>
        ) : (
          <div className="min-w-0">
            <div className="text-indigo-400 font-black tracking-tight">FactoryOS</div>
            <div className="text-[10px] text-slate-500 uppercase tracking-widest">Software Factory</div>
          </div>
        )}
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Footer */}
      <div className="p-3 border-t border-white/5 flex flex-col gap-0.5">
        {FOOTER_ITEMS.map(item => (
          <Link
            key={item.href}
            href={item.href}
            className="flex items-center gap-3 px-3 py-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-[#171f33] transition-all"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>{item.icon}</span>
            <span>{item.label}</span>
          </Link>
        ))}
      </div>
    </aside>
  )
}
