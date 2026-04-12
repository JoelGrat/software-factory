import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getProvider } from '@/lib/ai/registry'
import { runPlanGenerationPhase } from '@/lib/pipeline/phases/plan-generation'

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: change } = await db
    .from('change_requests')
    .select('id, status, projects!inner(owner_id)')
    .eq('id', id)
    .eq('projects.owner_id', user.id)
    .single()

  if (!change) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const ALLOWED = ['analyzed', 'planned', 'awaiting_approval']
  if (!ALLOWED.includes(change.status)) {
    return NextResponse.json(
      { error: `Cannot generate plan from status '${change.status}'. Must be 'analyzed', 'planned', or 'awaiting_approval'.` },
      { status: 409 }
    )
  }

  // Ensure pipeline_status is set correctly for the phase precondition check
  // and reset change status to 'planning' so the polling loop engages
  const adminDb = createAdminClient()
  await adminDb.from('change_requests')
    .update({ status: 'planning', pipeline_status: 'impact_analyzed' })
    .eq('id', id)

  const ai = getProvider()
  runPlanGenerationPhase(id, adminDb, ai).catch(err =>
    console.error(`[plan-generation-phase] change ${id} failed:`, err)
  )

  return NextResponse.json({ status: 'planning' }, { status: 202 })
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: change } = await db
    .from('change_requests')
    .select('id, projects!inner(owner_id)')
    .eq('id', id)
    .eq('projects.owner_id', user.id)
    .single()

  if (!change) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: plan } = await db
    .from('change_plans')
    .select('id, status, spec_markdown, estimated_tasks, estimated_files, created_at, approved_at')
    .eq('change_id', id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!plan) return NextResponse.json(null)

  const { data: tasks } = await db
    .from('change_plan_tasks')
    .select('id, component_id, description, order_index, status, system_components(name, type)')
    .eq('plan_id', plan.id)
    .order('order_index', { ascending: true })

  return NextResponse.json({ ...plan, tasks: tasks ?? [] })
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: change } = await db
    .from('change_requests')
    .select('id, projects!inner(owner_id)')
    .eq('id', id)
    .eq('projects.owner_id', user.id)
    .single()

  if (!change) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await req.json()
  if (body.action !== 'approve') {
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  }

  const { data: plan } = await db
    .from('change_plans')
    .select('id')
    .eq('change_id', id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!plan) return NextResponse.json({ error: 'No plan found' }, { status: 404 })

  await db.from('change_plans')
    .update({ status: 'approved', approved_at: new Date().toISOString() })
    .eq('id', plan.id)

  return NextResponse.json({ status: 'approved' })
}
