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
    .select('id, project_id, title, intent, type, priority, status, pipeline_status, failed_phase, risk_level, confidence_score, analysis_quality, tags, created_at, updated_at')
    .eq('id', changeId)
    .eq('project_id', id)
    .single()

  if (!change) redirect(`/projects/${id}`)

  // Fetch impact if analyzed
  const { data: impact } = await db
    .from('change_impacts')
    .select('id, risk_score, blast_radius, primary_risk_factor, analysis_quality, requires_migration, requires_data_change')
    .eq('change_id', changeId)
    .maybeSingle()

  const { data: riskFactors } = impact
    ? await db
        .from('change_risk_factors')
        .select('factor, weight')
        .eq('change_id', changeId)
        .order('weight', { ascending: false })
    : { data: [] }

  const { data: impactComponents } = impact
    ? await db
        .from('change_impact_components')
        .select('component_id, impact_weight, source, system_components(name, type)')
        .eq('impact_id', impact.id)
        .order('impact_weight', { ascending: false })
        .limit(10)
    : { data: [] }

  // Fetch plan if exists
  const { data: plan } = await db
    .from('change_plans')
    .select('id, status, spec_markdown, estimated_tasks, estimated_files, approved_at')
    .eq('change_id', changeId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const { data: planTasks } = plan
    ? await db
        .from('change_plan_tasks')
        .select('id, component_id, description, order_index, status, system_components(name, type)')
        .eq('plan_id', plan.id)
        .order('order_index', { ascending: true })
    : { data: [] }

  // Fetch file paths for each component in the plan
  const componentIds = (planTasks ?? [])
    .map((t: any) => t.component_id)
    .filter(Boolean) as string[]

  const { data: componentFiles } = componentIds.length > 0
    ? await db
        .from('component_assignment')
        .select('component_id, files(path)')
        .in('component_id', componentIds)
        .eq('is_primary', true)
    : { data: [] }

  // Build component_id → file paths map
  // files is a single object (many-to-one join via file_id → files.id)
  const componentFileMap: Record<string, string[]> = {}
  for (const row of (componentFiles ?? []) as unknown as Array<{ component_id: string; files: { path: string } | null }>) {
    const path = row.files?.path
    if (!path) continue
    if (!componentFileMap[row.component_id]) componentFileMap[row.component_id] = []
    componentFileMap[row.component_id].push(path)
  }

  return (
    <ChangeDetailView
      project={project}
      change={change}
      impact={impact ?? null}
      riskFactors={riskFactors ?? []}
      impactComponents={(impactComponents ?? []) as any[]}
      plan={plan ?? null}
      planTasks={(planTasks ?? []) as any[]}
      componentFileMap={componentFileMap}
    />
  )
}
