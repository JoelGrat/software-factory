import type { ReactNode } from 'react'
import Link from 'next/link'
import { LeftNav } from '@/components/app/left-nav'
import { ProfileAvatar } from '@/components/app/profile-avatar'

interface Props {
  projectName: string
  projectId: string
  jobId?: string
  sidebar: ReactNode
  sidebarTitle: string
  children: ReactNode
}

export function JobShell({ projectName, projectId, sidebar, sidebarTitle, children }: Props) {
  return (
    <div className="flex flex-col h-screen bg-[#0b1326] text-on-surface overflow-hidden">
      {/* Top bar */}
      <header className="w-full h-16 flex-shrink-0 flex items-center justify-between px-6 bg-[#0b1326] border-b border-white/5 z-50 font-headline antialiased tracking-tight">
        <div className="flex items-center gap-2 text-sm">
          <Link href="/projects" className="font-black text-indigo-400 tracking-tighter hover:text-indigo-300 transition-colors">
            FactoryOS
          </Link>
          <span className="text-slate-600">/</span>
          <Link
            href={`/projects/${projectId}/requirements`}
            className="text-slate-400 hover:text-slate-200 transition-colors font-medium truncate max-w-[240px]"
          >
            {projectName}
          </Link>
        </div>

        <div className="flex items-center gap-1">
          <button className="p-2 text-slate-400 hover:bg-[#171f33] rounded-lg transition-all active:scale-95" title="Notifications">
            <span className="material-symbols-outlined text-[20px]">notifications</span>
          </button>
          <button className="p-2 text-slate-400 hover:bg-[#171f33] rounded-lg transition-all active:scale-95" title="Settings">
            <span className="material-symbols-outlined text-[20px]">settings</span>
          </button>
          <div className="w-px h-5 bg-white/10 mx-1" />
          <ProfileAvatar />
        </div>
      </header>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        <LeftNav projectName={projectName} />

        {/* Main + right sidebar */}
        <div className="flex flex-1 overflow-hidden">
          <main className="flex-1 overflow-y-auto bg-[#0b1326] p-10">
            {children}
          </main>

          {/* Right sidebar */}
          <aside className="w-72 flex-shrink-0 flex flex-col bg-[#131b2e] border-l border-white/5 shadow-[-8px_0_15px_-3px_rgba(0,0,0,0.3)]">
            <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between">
              <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400 font-headline">{sidebarTitle}</span>
            </div>
            <div className="flex-1 overflow-y-auto">
              {sidebar}
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}
