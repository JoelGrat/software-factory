import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { LeftNav } from '@/components/app/left-nav'
import { ProfileAvatar } from '@/components/app/profile-avatar'
import { ChangeIntakeForm } from '@/components/change/change-intake-form'
import Link from 'next/link'

export default async function NewChangePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ title?: string }>
}) {
  const { id } = await params
  const { title: prefilledTitle } = await searchParams
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) redirect('/login')

  const { data: project } = await db
    .from('projects')
    .select('id, name')
    .eq('id', id)
    .eq('owner_id', user.id)
    .single()

  if (!project) redirect('/projects')

  return (
    <div className="flex flex-col h-screen bg-[#0b1326] text-on-surface overflow-hidden">
      <header className="w-full h-16 flex-shrink-0 flex items-center justify-between px-6 bg-[#0b1326] border-b border-white/5 z-50 font-headline antialiased tracking-tight">
        <div className="flex items-center gap-2 text-sm">
          <Link href="/projects" className="font-black text-indigo-400 tracking-tighter hover:text-indigo-300 transition-colors">
            FactoryOS
          </Link>
          <span className="text-slate-600">/</span>
          <Link href={`/projects/${project.id}`} className="text-slate-400 hover:text-slate-200 transition-colors font-medium truncate max-w-[180px]">
            {project.name}
          </Link>
          <span className="text-slate-600">/</span>
          <span className="text-slate-200 font-medium">New Change</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-px h-5 bg-white/10 mx-1" />
          <ProfileAvatar />
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <LeftNav />
        <main className="flex-1 overflow-y-auto bg-[#0b1326] p-10">
          <div className="max-w-3xl mx-auto">
            <div className="mb-8">
              <p className="text-xs uppercase tracking-widest font-bold text-indigo-400 font-headline mb-1">Change Request</p>
              <h1 className="text-3xl font-extrabold font-headline tracking-tight text-on-surface">Submit a Change</h1>
              <p className="text-sm text-slate-400 mt-2">Describe what you want to change. The system will map it to components and compute impact.</p>
            </div>
            <ChangeIntakeForm projectId={project.id} initialTitle={prefilledTitle ?? ''} />
          </div>
        </main>
      </div>
    </div>
  )
}
