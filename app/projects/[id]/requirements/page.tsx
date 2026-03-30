import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { buildGapsWithDetails } from '@/lib/requirements/gaps-with-details'
import { Workspace } from '@/components/requirements/workspace'
// TODO: replaced in Plan 2/3/4 — old types removed in migration 006
/* eslint-disable @typescript-eslint/no-explicit-any */
// import type { Gap, Question, InvestigationTask, RequirementSummary } from '@/lib/supabase/types' // removed in migration 006

interface Props {
  params: Promise<{ id: string }>
}

export default async function RequirementsPage({ params }: Props) {
  const { id: projectId } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) redirect('/login')

  const { data: project } = await db
    .from('projects')
    .select('id, name, target_path')
    .eq('id', projectId)
    .eq('owner_id', user.id)
    .single()

  if (!project) redirect('/projects')

  let { data: req } = await db
    .from('requirements')
    .select('id, status, blocked_reason')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!req) {
    const { data: created } = await db
      .from('requirements')
      .insert({ project_id: projectId, title: 'Requirements', raw_input: '', status: 'draft' })
      .select('id, status, blocked_reason')
      .single()
    req = created
  }

  if (!req) redirect('/projects')

  const [
    { data: items },
    { data: gaps },
    { data: questions },
    { data: tasks },
    { data: vision },
  ] = await Promise.all([
    db.from('requirement_items').select('*').eq('requirement_id', req.id).order('created_at', { ascending: true }),
    db.from('gaps').select('*').eq('requirement_id', req.id),
    db.from('questions').select('*').eq('requirement_id', req.id),
    db.from('investigation_tasks').select('*').eq('requirement_id', req.id),
    db.from('project_visions').select('status').eq('project_id', projectId).maybeSingle(),
  ])

  const gapsWithDetails = buildGapsWithDetails(
    (gaps ?? []) as any[],
    (questions ?? []) as any[],
    (tasks ?? []) as any[]
  )

  const summary: any = {
    blocking_count: 0,
    high_risk_count: 0,
    coverage_pct: 0,
    unvalidated_count: 0,
    internal_score: 0,
    complexity_score: 0,
    risk_flags: [],
    status: req.status,
    blocked_reason: req.blocked_reason,
  }

  return (
    <Workspace
      requirementId={req.id}
      projectId={projectId}
      projectName={project.name}
      targetPath={project.target_path ?? null}
      isGenerating={vision?.status === 'generating'}
      initialItems={items ?? []}
      initialGaps={gapsWithDetails}
      initialSummary={summary}
    />
  )
}
