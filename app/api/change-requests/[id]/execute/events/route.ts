import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

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
    .select('id, status, projects!inner(owner_id)')
    .eq('id', id)
    .eq('projects.owner_id', user.id)
    .single()

  if (!change) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Get latest run
  const { data: run } = await db
    .from('execution_runs')
    .select('id, status, summary, started_at, ended_at, cancellation_requested')
    .eq('change_id', id)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!run) {
    return NextResponse.json({ run: null, events: [], tasks: [], changeStatus: change.status })
  }

  // Get all events for this run ordered by seq
  const { data: events } = await db
    .from('execution_events')
    .select('id, seq, iteration, event_type, phase, payload, created_at')
    .eq('run_id', run.id)
    .order('seq', { ascending: true })

  // Load latest plan's tasks for per-task status display
  const { data: latestPlan } = await db
    .from('change_plans')
    .select('id')
    .eq('change_id', id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  const { data: tasks } = latestPlan
    ? await db
        .from('change_plan_tasks')
        .select('id, description, order_index, status, files, failure_reason, blocked_by_task_id, completed_at')
        .eq('plan_id', latestPlan.id)
        .order('order_index', { ascending: true })
    : { data: [] }

  return NextResponse.json({
    run: {
      id: run.id,
      status: run.status,
      summary: run.summary,
      startedAt: run.started_at,
      endedAt: run.ended_at,
      cancellationRequested: run.cancellation_requested,
    },
    events: events ?? [],
    tasks: tasks ?? [],
    changeStatus: change.status,
  })
}
