import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { VisionScreen } from '@/components/agent/vision-screen'
import type { ProjectVision, VisionLog, RequirementItem } from '@/lib/supabase/types'

interface Props {
  params: Promise<{ id: string }>
}

export default async function VisionPage({ params }: Props) {
  const { id: projectId } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) redirect('/login')

  const { data: project } = await db
    .from('projects')
    .select('id, name, setup_mode')
    .eq('id', projectId)
    .eq('owner_id', user.id)
    .single()

  if (!project) redirect('/projects')

  // Ensure requirements row exists
  let { data: req } = await db
    .from('requirements')
    .select('id')
    .eq('project_id', projectId)
    .maybeSingle()

  if (!req) {
    const { data: created } = await db
      .from('requirements')
      .insert({ project_id: projectId, title: 'Requirements', raw_input: '', status: 'draft' })
      .select('id')
      .single()
    req = created
  }

  if (!req) redirect('/projects')

  // Upsert vision row
  await db.from('project_visions')
    .upsert({ project_id: projectId }, { onConflict: 'project_id', ignoreDuplicates: true })

  const { data: vision } = await db
    .from('project_visions')
    .select('*')
    .eq('project_id', projectId)
    .single()

  if (!vision) redirect('/projects')

  // If already done, skip to requirements
  if (vision.status === 'done') {
    redirect(`/projects/${projectId}/requirements`)
  }

  const [{ data: logs }, { data: items }] = await Promise.all([
    db.from('vision_logs').select('*').eq('project_id', projectId).order('created_at', { ascending: true }),
    db.from('requirement_items').select('*').eq('requirement_id', req.id).order('created_at', { ascending: true }),
  ])

  return (
    <VisionScreen
      projectId={projectId}
      projectName={project.name}
      requirementId={req.id}
      initialVision={vision as ProjectVision}
      initialLogs={(logs ?? []) as VisionLog[]}
      initialItems={(items ?? []) as RequirementItem[]}
    />
  )
}
