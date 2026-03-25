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
    <main className="max-w-2xl mx-auto py-12 px-4">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold">Projects</h1>
        <CreateProjectForm />
      </div>
      {!projects?.length ? (
        <p className="text-gray-500">No projects yet. Create one to get started.</p>
      ) : (
        <ul className="divide-y border rounded-lg">
          {projects.map(p => (
            <li key={p.id}>
              <Link
                href={`/projects/${p.id}/requirements`}
                className="flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors"
              >
                <span className="font-medium">{p.name}</span>
                <span className="text-xs text-gray-400">
                  {new Date(p.created_at).toLocaleDateString()}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
