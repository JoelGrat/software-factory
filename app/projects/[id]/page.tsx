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

  const [{ data: changes }, { count: fileCount }, { data: allComponents }] = await Promise.all([
    db.from('change_requests')
      .select('id, title, type, priority, status, risk_level, analysis_status, created_at, updated_at')
      .eq('project_id', id)
      .order('updated_at', { ascending: false }),
    db.from('files').select('*', { count: 'exact', head: true }).eq('project_id', id),
    db.from('system_components')
      .select('id, name, type, status, is_anchored')
      .eq('project_id', id)
      .is('deleted_at', null)
      .order('name'),
  ])

  const allIds = (allComponents ?? []).map(c => c.id)

  const [{ data: assignments }, { data: deps }] = allIds.length > 0
    ? await Promise.all([
        db.from('component_assignment').select('component_id, confidence').in('component_id', allIds).eq('is_primary', true),
        db.from('component_dependencies').select('from_id, to_id').in('from_id', allIds).is('deleted_at', null),
      ])
    : [{ data: [] }, { data: [] }]

  // Fetch active changes — exclude completed/stalled, but always keep failed so users can retry or dismiss
  // Active changes: everything that hasn't finished (not done/review).
  // Intentionally status-based, not analysis_status-based, to avoid a race
  // where re-triggered execution sets status='executing' before analysis_status
  // transitions from 'completed' (left by the cancelled run) to 'running'.
  const { data: activeChangesRaw } = await db
    .from('change_requests')
    .select('id, title, status, analysis_status, pipeline_status, risk_level, updated_at')
    .eq('project_id', id)
    .not('status', 'in', '("done","review")')
    .order('updated_at', { ascending: false })

  // Fetch recent analysis snapshots
  const changeIds = (changes ?? []).map(c => c.id)
  const { data: rawSnapshots } = changeIds.length > 0
    ? await db
        .from('analysis_result_snapshot')
        .select('*')
        .in('change_id', changeIds)
        .order('completed_at', { ascending: false })
        .limit(10)
    : { data: [] }

  // Map snake_case DB columns → camelCase to match AnalysisResultSnapshotData
  const recentSnapshots = (rawSnapshots ?? []).map(s => ({
    changeId: s.change_id,
    version: s.version,
    executionOutcome: s.execution_outcome,
    snapshotStatus: s.snapshot_status,
    minimal: s.minimal,
    analysisStatus: s.analysis_status,
    stagesCompleted: s.stages_completed,
    filesModified: s.files_modified,
    componentsAffected: s.components_affected,
    jaccardAccuracy: s.jaccard_accuracy,
    missRate: s.miss_rate,
    modelMiss: s.model_miss,
    failureCause: s.failure_cause,
    durationMs: s.duration_ms,
    completedAt: s.completed_at,
  }))

  // Fetch precomputed dashboard data
  const [
    { data: riskScoresRaw },
    { data: actionItemsRaw },
    { data: signalSnapshot },
  ] = await Promise.all([
    db.from('risk_scores')
      .select('component_id, risk_score, tier, system_components(name)')
      .eq('project_id', id)
      .order('risk_score', { ascending: false })
      .limit(5),
    db.from('action_items')
      .select('id, tier, priority_score, source, payload_json')
      .eq('project_id', id)
      .is('resolved_at', null)
      .order('priority_score', { ascending: false })
      .limit(5),
    db.from('system_signal_snapshot')
      .select('payload_json, computed_at')
      .eq('project_id', id)
      .maybeSingle(),
  ])

  const riskScores = (riskScoresRaw ?? []).map(r => ({
    componentId: r.component_id,
    componentName: (r.system_components as any)?.name ?? r.component_id,
    riskScore: r.risk_score,
    tier: r.tier as 'HIGH' | 'MEDIUM',
    incomingDeps: 0,
  }))

  const actionItems = (actionItemsRaw ?? []).map(r => ({
    id: r.id,
    tier: r.tier,
    source: r.source,
    priorityScore: r.priority_score,
    payload: r.payload_json as any,
  }))

  // Per-component file counts and confidence
  const fileCountMap: Record<string, number> = {}
  const confAccum: Record<string, { total: number; n: number }> = {}
  for (const a of (assignments ?? [])) {
    fileCountMap[a.component_id] = (fileCountMap[a.component_id] ?? 0) + 1
    if (!confAccum[a.component_id]) confAccum[a.component_id] = { total: 0, n: 0 }
    confAccum[a.component_id].total += a.confidence
    confAccum[a.component_id].n++
  }
  const outgoingMap: Record<string, number> = {}
  const incomingMap: Record<string, number> = {}
  for (const d of (deps ?? [])) {
    outgoingMap[d.from_id] = (outgoingMap[d.from_id] ?? 0) + 1
    incomingMap[d.to_id] = (incomingMap[d.to_id] ?? 0) + 1
  }

  const components = (allComponents ?? []).map(c => {
    const conf = confAccum[c.id]
    return {
      id: c.id,
      name: c.name,
      type: c.type,
      status: c.status,
      is_anchored: c.is_anchored,
      fileCount: fileCountMap[c.id] ?? 0,
      confidence: conf ? Math.round(conf.total / conf.n) : 50,
      incomingDeps: incomingMap[c.id] ?? 0,
      outgoingDeps: outgoingMap[c.id] ?? 0,
    }
  })

  const totalConfSum = Object.values(confAccum).reduce((s, v) => s + v.total, 0)
  const totalConfN   = Object.values(confAccum).reduce((s, v) => s + v.n,     0)

  return (
    <ProjectDashboard
      project={project as any}
      initialChanges={changes ?? []}
      initialStats={{
        fileCount: fileCount ?? 0,
        componentCount: components.length,
        edgeCount: (deps ?? []).length,
        lowConfidenceCount: components.filter(c => c.confidence < 40).length,
        unstableCount: components.filter(c => c.status === 'unstable').length,
        avgConfidence: totalConfN > 0 ? Math.round(totalConfSum / totalConfN) : 0,
      }}
      initialComponents={components}
      initialSnapshots={recentSnapshots ?? []}
      initialActiveChanges={activeChangesRaw ?? []}
      initialRiskScores={riskScores}
      initialActionItems={actionItems}
      signalSnapshot={signalSnapshot?.payload_json as any ?? null}
    />
  )
}
