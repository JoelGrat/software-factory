import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { buildGapsWithDetails } from '@/lib/requirements/gaps-with-details'
import { Workspace } from '@/components/requirements/workspace'
import { JobShell } from '@/components/agent/job-shell'
import { StepIndicator } from '@/components/agent/step-indicator'
import type { Gap, Question, InvestigationTask, RequirementSummary } from '@/lib/supabase/types'

interface Props {
  params: Promise<{ id: string }>
}

export default async function RequirementsPage({ params }: Props) {
  const { id: projectId } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) redirect('/login')

  const { data: project, error: projectError } = await db
    .from('projects')
    .select('id, name, target_path')
    .eq('id', projectId)
    .eq('owner_id', user.id)
    .single()

  if (projectError) console.error('[requirements] project fetch failed:', projectError.message)
  if (!project) redirect('/projects')

  let { data: req } = await db
    .from('requirements')
    .select('id, title, raw_input, status, blocked_reason')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!req) {
    const { data: created, error: insertError } = await db
      .from('requirements')
      .insert({ project_id: projectId, title: 'Requirements', raw_input: '', status: 'draft' })
      .select('id, title, raw_input, status, blocked_reason')
      .single()
    if (insertError) console.error('Failed to create requirement:', insertError.message)
    req = created
  }

  if (!req) redirect('/projects')

  const [
    { data: items },
    { data: gaps },
    { data: questions },
    { data: tasks },
    { data: latestScore },
  ] = await Promise.all([
    db.from('requirement_items').select('*').eq('requirement_id', req.id).order('created_at', { ascending: true }),
    db.from('gaps').select('*').eq('requirement_id', req.id),
    db.from('questions').select('*').eq('requirement_id', req.id),
    db.from('investigation_tasks').select('*').eq('requirement_id', req.id),
    db.from('completeness_scores').select('blocking_count, high_risk_count, coverage_pct, internal_score, complexity_score, risk_flags').eq('requirement_id', req.id).order('scored_at', { ascending: false }).limit(1).maybeSingle(),
  ])

  const gapsWithDetails = buildGapsWithDetails(
    (gaps ?? []) as Gap[],
    (questions ?? []) as Question[],
    (tasks ?? []) as InvestigationTask[]
  )

  const activeGaps = ((gaps ?? []) as Gap[]).filter(g => !g.resolved_at && !g.merged_into)
  const summary: RequirementSummary = {
    blocking_count: latestScore?.blocking_count ?? activeGaps.filter(g => g.severity === 'critical').length,
    high_risk_count: latestScore?.high_risk_count ?? activeGaps.filter(g => g.severity === 'major').length,
    coverage_pct: latestScore?.coverage_pct ?? 0,
    unvalidated_count: activeGaps.filter(g => !g.validated).length,
    internal_score: latestScore?.internal_score ?? 0,
    complexity_score: latestScore?.complexity_score ?? 0,
    risk_flags: (latestScore?.risk_flags as string[]) ?? [],
    status: req.status,
    blocked_reason: req.blocked_reason,
  }

  const sidebar = (
    <div className="p-5 space-y-4">
      <div className="p-3 bg-surface-container rounded-lg border border-outline-variant/10">
        <div className="text-[10px] text-outline uppercase font-bold mb-1">Status</div>
        <div className="text-sm font-semibold text-indigo-200 capitalize">{summary.status}</div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="p-3 bg-surface-container rounded-lg border border-outline-variant/10 text-center">
          <div className="text-[10px] text-outline uppercase font-bold mb-1">Coverage</div>
          <div className="text-xl font-bold font-headline text-indigo-100">{summary.coverage_pct}%</div>
        </div>
        <div className="p-3 bg-surface-container rounded-lg border border-outline-variant/10 text-center">
          <div className="text-[10px] text-outline uppercase font-bold mb-1">Blocking</div>
          <div className={`text-xl font-bold font-headline ${summary.blocking_count > 0 ? 'text-error' : 'text-[#22c55e]'}`}>
            {summary.blocking_count}
          </div>
        </div>
      </div>
    </div>
  )

  return (
    <JobShell
      projectName={project.name}
      projectId={projectId}
      sidebar={sidebar}
      sidebarTitle="Requirements Status"
    >
      <StepIndicator current={2} />
      <Workspace
        requirementId={req.id}
        projectId={projectId}
        targetPath={project.target_path ?? null}
        initialItems={items ?? []}
        initialGaps={gapsWithDetails}
        initialSummary={summary}
      />
    </JobShell>
  )
}
