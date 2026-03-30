import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { CreateProjectForm } from '@/components/projects/create-project-form'
import { ProjectList } from '@/components/projects/project-list'
import { LeftNav } from '@/components/app/left-nav'
import { ProfileAvatar } from '@/components/app/profile-avatar'

export default async function ProjectsPage() {
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) redirect('/login')

  const { data: projects } = await db
    .from('projects')
    .select('id, name, scan_status, created_at')
    .eq('owner_id', user.id)
    .order('created_at', { ascending: false })

  return (
    <div className="flex flex-col h-screen bg-[#0b1326] text-on-surface overflow-hidden">
      {/* Top bar */}
      <header className="w-full h-16 flex-shrink-0 flex items-center justify-between px-6 bg-[#0b1326] border-b border-white/5 z-50 font-headline antialiased tracking-tight">
        <span className="text-xl font-bold text-indigo-400 tracking-tighter">FactoryOS</span>

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
        <LeftNav />

        <main className="flex-1 overflow-y-auto bg-[#0b1326] p-10">
          <div className="max-w-3xl mx-auto">
            <div className="flex items-center justify-between mb-10">
              <div>
                <p className="text-xs uppercase tracking-widest font-bold text-indigo-400 font-headline mb-1">
                  Software Factory
                </p>
                <h1 className="text-3xl font-extrabold font-headline tracking-tight text-on-surface">
                  Projects
                </h1>
              </div>
              <CreateProjectForm />
            </div>

            <ProjectList projects={projects ?? []} />
          </div>
        </main>
      </div>
    </div>
  )
}
