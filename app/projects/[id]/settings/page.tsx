import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ProjectSettingsView } from './project-settings-view'

export default async function ProjectSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) redirect('/login')

  const { data: project } = await db
    .from('projects')
    .select('id, name, repo_url, repo_token, scan_status, created_at')
    .eq('id', id)
    .eq('owner_id', user.id)
    .single()

  if (!project) redirect('/projects')

  // project_settings column may not exist yet (migration 012 pending)
  const { data: settingsRow } = await db
    .from('projects')
    .select('project_settings')
    .eq('id', id)
    .single()
  const project_settings = (settingsRow as any)?.project_settings ?? {}

  // Model health stats
  const { data: compRows } = await db
    .from('system_components')
    .select('id, status')
    .eq('project_id', id)
    .is('deleted_at', null)

  const compIds = (compRows ?? []).map(c => c.id)

  const [{ count: fileCount }, { data: confRows }] = await Promise.all([
    db.from('files').select('*', { count: 'exact', head: true }).eq('project_id', id),
    compIds.length > 0
      ? db.from('component_assignment').select('confidence').in('component_id', compIds).eq('is_primary', true)
      : Promise.resolve({ data: [] }),
  ])

  const confArr = ((confRows ?? []) as { confidence: number }[]).map(r => r.confidence)
  const avgConfidence = confArr.length > 0 ? Math.round(confArr.reduce((s, v) => s + v, 0) / confArr.length) : 0
  const lowConfCount = confArr.filter(v => v < 40).length
  const assignedFileCount = confArr.length

  // Danger zone counts
  const [{ count: changeCount }, { count: snapCount }] = await Promise.all([
    db.from('change_requests').select('*', { count: 'exact', head: true }).eq('project_id', id),
    db.from('execution_snapshots').select('*', { count: 'exact', head: true })
      .in('change_id',
        compIds.length > 0
          ? await db.from('change_requests').select('id').eq('project_id', id).then(r => (r.data ?? []).map((c: any) => c.id))
          : []
      ),
  ])

  const modelHealth = {
    componentCount: compRows?.length ?? 0,
    fileCount: fileCount ?? 0,
    assignedFileCount,
    avgConfidence,
    lowConfCount,
  }

  const dangerStats = {
    componentCount: compRows?.length ?? 0,
    changeCount: changeCount ?? 0,
    executionCount: snapCount ?? 0,
  }

  return (
    <ProjectSettingsView
      project={{ ...project, project_settings } as any}
      modelHealth={modelHealth}
      dangerStats={dangerStats}
    />
  )
}
