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
      id, project_id, title, intent, type, priority, status,
      risk_level, confidence_score, confidence_breakdown, analysis_quality,
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
    .select('id, status, estimated_tasks, estimated_files, approved_at')
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

  return NextResponse.json({
    ...change,
    impact: impact ?? null,
    risk_factors: riskFactors ?? [],
    impact_components: impactComponents ?? [],
    plan: plan ?? null,
    plan_tasks: planTasks ?? [],
  })
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
