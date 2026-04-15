import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { validatePatchChangeRequest } from '@/lib/change-requests/validator'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: change } = await db
    .from('change_requests')
    .select(`
      id, project_id, title, intent, type, priority, status, pipeline_status,
      risk_level, confidence_score, confidence_breakdown, analysis_quality,
      failed_stage, retryable, failure_diagnostics,
      lock_version, execution_group, triggered_by, tags, created_at, updated_at,
      projects!inner(owner_id)
    `)
    .eq('id', id)
    .eq('projects.owner_id', user.id)
    .single()

  if (!change) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Fetch related impact if analyzed
  const { data: impact } = await db
    .from('change_impacts')
    .select('id, risk_score, blast_radius, primary_risk_factor, analysis_quality, requires_migration, requires_data_change')
    .eq('change_id', id)
    .maybeSingle()

  const { data: riskFactors } = impact
    ? await db
        .from('change_risk_factors')
        .select('factor, weight')
        .eq('change_id', id)
        .order('weight', { ascending: false })
    : { data: [] }

  const { data: impactComponents } = impact
    ? await db
        .from('change_impact_components')
        .select('component_id, impact_weight, source, source_detail, system_components(name, type)')
        .eq('impact_id', impact.id)
        .order('impact_weight', { ascending: false })
        .limit(10)
    : { data: [] }

  // Fetch plan if exists
  const { data: plan } = await db
    .from('change_plans')
    .select('id, status, estimated_tasks, branch_name, plan_quality_score, plan_json, approved_at')
    .eq('change_id', id)
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

  // Fetch latest spec markdown
  const { data: specRow } = await db
    .from('change_specs')
    .select('markdown')
    .eq('change_id', id)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()

  return NextResponse.json({
    ...change,
    impact: impact ?? null,
    risk_factors: riskFactors ?? [],
    impact_components: impactComponents ?? [],
    plan: plan ?? null,
    plan_tasks: planTasks ?? [],
    spec_markdown: specRow?.markdown ?? null,
  })
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: change } = await db
    .from('change_requests')
    .select('id, status, project_id, projects!inner(owner_id, repo_url, repo_token)')
    .eq('id', id)
    .eq('projects.owner_id', user.id)
    .single()

  if (!change) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  if (change.status === 'done') {
    return NextResponse.json({ error: 'Cannot delete a change that has been approved' }, { status: 409 })
  }

  // Best-effort: delete the git branch from GitHub before removing DB records
  const project = (change as any).projects as { repo_url: string | null; repo_token: string | null } | null
  if (project?.repo_url && project?.repo_token) {
    const { data: commit } = await db
      .from('change_commits')
      .select('branch_name')
      .eq('change_id', id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const branchName = commit?.branch_name ?? (await db
      .from('change_plans')
      .select('branch_name')
      .eq('change_id', id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(r => r.data?.branch_name))

    if (branchName) {
      const repoPath = project.repo_url
        .replace(/^https?:\/\/github\.com\//, '')
        .replace(/\.git$/, '')
      const ghUrl = `https://api.github.com/repos/${repoPath}/git/refs/heads/${branchName}`
      await fetch(ghUrl, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${project.repo_token}`,
          Accept: 'application/vnd.github+json',
        },
      }).catch(() => { /* branch may not exist — ignore */ })
    }
  }

  const { error } = await db.from('change_requests').delete().eq('id', id)
  if (error) return NextResponse.json({ error: 'Delete failed' }, { status: 500 })

  return new NextResponse(null, { status: 204 })
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Verify ownership via project
  const { data: change } = await db
    .from('change_requests')
    .select('id, projects!inner(owner_id)')
    .eq('id', id)
    .eq('projects.owner_id', user.id)
    .single()

  if (!change) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await req.json()
  const validation = validatePatchChangeRequest(body)
  if (!validation.valid) return NextResponse.json({ error: validation.error }, { status: 400 })

  const { data, error } = await db
    .from('change_requests')
    .update({ ...validation.updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('id, title, priority, tags, status, updated_at')
    .single()

  if (error || !data) return NextResponse.json({ error: 'Update failed' }, { status: 500 })
  return NextResponse.json(data)
}
