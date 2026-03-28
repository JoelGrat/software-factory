import { redirect } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { CreateProjectForm } from '@/components/projects/create-project-form'

export default async function ProjectsPage() {
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) redirect('/login')

  const { data: projects } = await db
    .from('projects')
    .select('id, name, created_at')
    .eq('owner_id', user.id)
    .order('created_at', { ascending: false })

  return (
    <main className="min-h-screen" style={{ background: 'var(--bg-base)' }}>
      <div className="max-w-3xl mx-auto px-6 py-12">
        <div className="flex items-center justify-between mb-10">
          <div>
            <p className="text-xs uppercase tracking-widest mb-1" style={{ color: 'var(--accent)', fontFamily: 'var(--font-jetbrains)' }}>
              Software Factory
            </p>
            <h1 className="text-3xl font-bold" style={{ fontFamily: 'var(--font-syne)', color: 'var(--text-primary)' }}>
              Projects
            </h1>
          </div>
          <CreateProjectForm />
        </div>

        {!projects?.length ? (
          <div
            className="rounded-xl p-12 text-center"
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-subtle)' }}
          >
            <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
              No projects yet. Create one to get started.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {projects.map(p => (
              <Link
                key={p.id}
                href={`/projects/${p.id}/requirements`}
                className="flex items-center justify-between px-5 py-4 rounded-xl group transition-all"
                style={{
                  background: 'var(--bg-surface)',
                  border: '1px solid var(--border-subtle)',
                }}
                onMouseEnter={e => {
                  const el = e.currentTarget as HTMLElement
                  el.style.borderColor = 'var(--border-default)'
                  el.style.background = 'var(--bg-elevated)'
                }}
                onMouseLeave={e => {
                  const el = e.currentTarget as HTMLElement
                  el.style.borderColor = 'var(--border-subtle)'
                  el.style.background = 'var(--bg-surface)'
                }}
              >
                <div className="flex items-center gap-3">
                  <div className="w-2 h-2 rounded-full" style={{ background: 'var(--accent)', boxShadow: '0 0 6px var(--accent)' }} />
                  <span className="font-medium text-sm" style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-syne)' }}>
                    {p.name}
                  </span>
                </div>
                <span className="text-xs font-mono" style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-jetbrains)' }}>
                  {new Date(p.created_at).toLocaleDateString()}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </main>
  )
}
