// app/api/change-requests/[id]/plan/tasks/route.ts
// Appends a single task to the latest plan for a change request.
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function POST(
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

  const body = await req.json().catch(() => ({}))
  const description = typeof body.description === 'string' ? body.description.trim() : ''
  if (!description) {
    return NextResponse.json({ error: 'description is required' }, { status: 400 })
  }

  const { data: plan } = await db
    .from('change_plans')
    .select('id')
    .eq('change_id', id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!plan) return NextResponse.json({ error: 'No plan found' }, { status: 404 })

  const { data: existingTasks } = await db
    .from('change_plan_tasks')
    .select('order_index')
    .eq('plan_id', plan.id)

  const maxIndex = (existingTasks ?? []).reduce(
    (max: number, t: { order_index: number }) => Math.max(max, t.order_index),
    -1
  )
  const { data: task, error } = await db
    .from('change_plan_tasks')
    .insert({
      plan_id: plan.id,
      component_id: null,
      description,
      order_index: maxIndex + 1,
      status: 'pending',
    })
    .select()
    .single()
  if (error) throw error
  return NextResponse.json(task, { status: 201 })
}
