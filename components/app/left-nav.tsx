'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

const NAV_ITEMS = [
  { href: '/projects', icon: 'deployed_code', label: 'Projects' },
]

const FOOTER_ITEMS = [
  { href: '/settings', icon: 'settings', label: 'Settings' },
  { href: 'https://docs.softwarefactory.dev', icon: 'menu_book', label: 'Docs' },
  { href: '/support', icon: 'help_outline', label: 'Support' },
]

export function LeftNav() {
  const pathname = usePathname()

  return (
    <aside className="h-full w-64 flex-shrink-0 flex flex-col bg-[#131b2e] border-r border-white/5 font-headline text-sm font-medium">
      {/* Branding */}
      <div className="flex items-center gap-3 px-4 py-4 border-b border-white/5">
        <div className="w-8 h-8 rounded-lg bg-indigo-500/20 flex items-center justify-center flex-shrink-0">
          <span className="material-symbols-outlined text-indigo-400 text-[18px]">precision_manufacturing</span>
        </div>
        <div className="min-w-0">
          <div className="text-indigo-400 font-black tracking-tight truncate">FactoryOS</div>
          <div className="text-[10px] text-slate-500 uppercase tracking-widest">Software Factory</div>
        </div>
      </div>

      {/* Nav items */}
      <nav className="flex flex-col gap-0.5 p-3 flex-1">
        {NAV_ITEMS.map(item => {
          const active = pathname.startsWith(item.href)
          return (
            <Link
              key={item.href}
              href={item.href}
              className={[
                'flex items-center gap-3 px-3 py-2 rounded-lg transition-all duration-200',
                active
                  ? 'bg-indigo-500/10 text-indigo-400 border-r-4 border-indigo-500'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-[#171f33]',
              ].join(' ')}
            >
              <span className="material-symbols-outlined text-[20px]">{item.icon}</span>
              <span>{item.label}</span>
            </Link>
          )
        })}
      </nav>

      {/* Footer */}
      <div className="p-3 border-t border-white/5 flex flex-col gap-0.5">
        {FOOTER_ITEMS.map(item => (
          <Link
            key={item.href}
            href={item.href}
            className="flex items-center gap-3 px-3 py-2 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-[#171f33] transition-all"
          >
            <span className="material-symbols-outlined text-[20px]">{item.icon}</span>
            <span>{item.label}</span>
          </Link>
        ))}
      </div>
    </aside>
  )
}
