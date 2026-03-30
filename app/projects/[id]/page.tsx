import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ProjectDashboard } from './project-dashboard'

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) redirect('/login')

  const { data: project } = await db
    .from('projects')
    .select('id, name, scan_status, scan_error, repo_url, created_at')
    .eq('id', id)
    .eq('owner_id', user.id)
    .single()

  if (!project) redirect('/projects')

  const { data: changes } = await db
    .from('change_requests')
    .select('id, title, type, priority, status, risk_level, created_at, updated_at')
    .eq('project_id', id)
    .order('updated_at', { ascending: false })

  return <ProjectDashboard project={project} initialChanges={changes ?? []} />
}
