import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ChangeDetailView } from './change-detail-view'

export default async function ChangeDetailPage({
  params,
}: {
  params: Promise<{ id: string; changeId: string }>
}) {
  const { id, changeId } = await params
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

  const { data: change } = await db
    .from('change_requests')
    .select('id, project_id, title, intent, type, priority, status, risk_level, confidence_score, analysis_quality, tags, created_at, updated_at')
    .eq('id', changeId)
    .eq('project_id', id)
    .single()

  if (!change) redirect(`/projects/${id}`)

  return <ChangeDetailView project={project} change={change} />
}
