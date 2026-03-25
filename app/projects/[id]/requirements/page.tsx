import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { buildGapsWithDetails } from '@/lib/requirements/gaps-with-details'
import { Workspace } from '@/components/requirements/workspace'
import type { Gap, Question, InvestigationTask, RequirementSummary } from '@/lib/supabase/types'

interface Props {
  params: Promise<{ id: string }>
}

export default async function RequirementsPage({ params }: Props) {
  const { id: projectId } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) redirect('/login')

  // Verify project ownership
  const { data: project } = await db
    .from('projects')
    .select('id, name')
    .eq('id', projectId)
    .eq('owner_id', user.id)
    .single()

  if (!project) redirect('/projects')

  // Get or create requirement for this project
  let { data: req } = await db
    .from('requirements')
    .select('id, title, raw_input, status, blocked_reason')
    .eq('project_id', projectId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!req) {
    const { data: created } = await db
      .from('requirements')
      .insert({ project_id: projectId, title: 'Requirements', raw_input: '', status: 'draft' })
      .select('id, title, raw_input, status, blocked_reason')
      .single()
    req = created
  }

  if (!req) redirect('/projects')

  // Load workspace data in parallel
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
    db.from('completeness_scores').select('overall_score, completeness, nfr_score, confidence').eq('requirement_id', req.id).order('scored_at', { ascending: false }).limit(1).maybeSingle(),
  ])

  const gapsWithDetails = buildGapsWithDetails(
    (gaps ?? []) as Gap[],
    (questions ?? []) as Question[],
    (tasks ?? []) as InvestigationTask[]
  )

  const activeGaps = ((gaps ?? []) as Gap[]).filter(g => !g.resolved_at && !g.merged_into)
  const summary: RequirementSummary = {
    critical_count: activeGaps.filter(g => g.severity === 'critical').length,
    major_count: activeGaps.filter(g => g.severity === 'major').length,
    minor_count: activeGaps.filter(g => g.severity === 'minor').length,
    completeness: latestScore?.completeness ?? 0,
    confidence: latestScore?.confidence ?? 0,
    overall_score: latestScore?.overall_score ?? 0,
    status: req.status,
    blocked_reason: req.blocked_reason,
  }

  return (
    <main className="max-w-4xl mx-auto py-8 px-4">
      <div className="flex items-center justify-between mb-6">
        <div>
          <p className="text-sm text-gray-500 mb-1">
            <a href="/projects" className="hover:underline">Projects</a>
            {' / '}
            {project.name}
          </p>
          <h1 className="text-2xl font-bold">{req.title}</h1>
        </div>
      </div>

      <Workspace
        requirementId={req.id}
        initialRawInput={req.raw_input ?? ''}
        initialItems={items ?? []}
        initialGaps={gapsWithDetails}
        initialSummary={summary}
      />
    </main>
  )
}
