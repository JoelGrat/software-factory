import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { SystemModelBrowser } from './system-model-browser'

export default async function SystemModelPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) redirect('/login')

  const { data: project } = await db
    .from('projects')
    .select('id, name, scan_status')
    .eq('id', id)
    .eq('owner_id', user.id)
    .single()

  if (!project) redirect('/projects')

  const { data: components } = await db
    .from('system_components')
    .select('id, name, type, status, is_anchored, scan_count, last_updated')
    .eq('project_id', id)
    .is('deleted_at', null)
    .order('name')

  // Count primary file assignments per component
  const { data: assignments } = await db
    .from('component_assignment')
    .select('component_id')
    .in('component_id', (components ?? []).map(c => c.id))
    .eq('is_primary', true)

  const fileCounts: Record<string, number> = {}
  for (const a of (assignments ?? [])) {
    fileCounts[a.component_id] = (fileCounts[a.component_id] ?? 0) + 1
  }

  // Fetch outgoing dependencies for all components
  const { data: dependencies } = await db
    .from('component_dependencies')
    .select('from_id, to_id')
    .in('from_id', (components ?? []).map(c => c.id))
    .is('deleted_at', null)

  return (
    <SystemModelBrowser
      project={project}
      components={(components ?? []).map(c => ({
        ...c,
        fileCount: fileCounts[c.id] ?? 0,
      }))}
      dependencies={dependencies ?? []}
    />
  )
}
