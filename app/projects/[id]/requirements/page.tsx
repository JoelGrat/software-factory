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

  const { data: project } = await db
    .from('projects')
    .select('id, name')
    .eq('id', projectId)
    .eq('owner_id', user.id)
    .single()

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
    <main className="min-h-screen" style={{ background: 'var(--bg-base)' }}>
      <header style={{ borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-surface)' }}>
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center gap-3">
          <a
            href="/projects"
            className="text-xs uppercase tracking-widest transition-colors"
            style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-jetbrains)' }}
          >
            Projects
          </a>
          <span style={{ color: 'var(--border-strong)' }}>/</span>
          <span className="text-xs uppercase tracking-widest" style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-jetbrains)' }}>
            {project.name}
          </span>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-bold mb-8" style={{ fontFamily: 'var(--font-syne)', color: 'var(--text-primary)' }}>
          {req.title}
        </h1>
        <Workspace
          requirementId={req.id}
          initialRawInput={req.raw_input ?? ''}
          initialItems={items ?? []}
          initialGaps={gapsWithDetails}
          initialSummary={summary}
        />
      </div>
    </main>
  )
}
