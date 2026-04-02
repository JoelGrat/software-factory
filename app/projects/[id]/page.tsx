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
    .select('id, name, scan_status, scan_error, scan_progress, repo_url, created_at')
    .eq('id', id)
    .eq('owner_id', user.id)
    .single()

  if (!project) redirect('/projects')

  const [
    { data: changes },
    { count: fileCount },
    { count: componentCount },
    { count: edgeCount },
    { data: topComponents },
  ] = await Promise.all([
    db.from('change_requests')
      .select('id, title, type, priority, status, risk_level, created_at, updated_at')
      .eq('project_id', id)
      .order('updated_at', { ascending: false }),
    db.from('files').select('*', { count: 'exact', head: true }).eq('project_id', id),
    db.from('system_components').select('*', { count: 'exact', head: true }).eq('project_id', id).is('deleted_at', null),
    db.from('component_graph_edges').select('*', { count: 'exact', head: true }).eq('project_id', id),
    db.from('system_components')
      .select('id, name, type, status, is_anchored, scan_count')
      .eq('project_id', id)
      .is('deleted_at', null)
      .order('scan_count', { ascending: false })
      .limit(12),
  ])

  const topIds = (topComponents ?? []).map(c => c.id)
  const { count: lowConfCount } = topIds.length > 0
    ? await db.from('component_assignment').select('*', { count: 'exact', head: true }).lt('confidence', 60).in('component_id', topIds)
    : { count: 0 }

  return (
    <ProjectDashboard
      project={project as any}
      initialChanges={changes ?? []}
      initialStats={{
        fileCount: fileCount ?? 0,
        componentCount: componentCount ?? 0,
        edgeCount: edgeCount ?? 0,
        lowConfidenceCount: lowConfCount ?? 0,
      }}
      initialTopComponents={topComponents ?? []}
    />
  )
}
