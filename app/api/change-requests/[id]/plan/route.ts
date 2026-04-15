import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getProvider } from '@/lib/ai/registry'
import { runPipeline } from '@/lib/pipeline/orchestrator'

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

  const BLOCKED = ['planning', 'executing', 'review']
  if (BLOCKED.includes(change.status)) {
    return NextResponse.json(
      { error: `Cannot trigger planning while change is in progress (status: '${change.status}').` },
      { status: 409 }
    )
  }

  const adminDb = createAdminClient()
  const ai = getProvider()
  runPipeline(id, adminDb, ai).catch((err: unknown) =>
    console.error(`[pipeline] change ${id} failed:`, err)
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
    .select('id, status, branch_name, plan_json, plan_quality_score, version, current_stage, created_at, approved_at')
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
