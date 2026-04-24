import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getProvider } from '@/lib/ai/registry'
import { analyzeFeedback } from '@/lib/feedback/feedback-analyzer'

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

  const body = await req.json().catch(() => ({})) as { feedback?: unknown }
  const feedback = typeof body.feedback === 'string' ? body.feedback.trim() : ''
  if (!feedback) return NextResponse.json({ error: 'feedback is required' }, { status: 400 })

  const { data: latestPlan } = await db
    .from('change_plans')
    .select('id')
    .eq('change_id', id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!latestPlan) return NextResponse.json({ error: 'No plan found' }, { status: 404 })

  const { data: tasks } = await db
    .from('change_plan_tasks')
    .select('id, description, order_index, dependencies')
    .eq('plan_id', latestPlan.id)
    .order('order_index', { ascending: true })

  if (!tasks || tasks.length === 0) {
    return NextResponse.json({ error: 'No tasks found' }, { status: 404 })
  }

  const ai = getProvider()
  const result = await analyzeFeedback(
    feedback,
    tasks as { id: string; order_index: number; description: string; dependencies: string[] }[],
    ai,
  )

  return NextResponse.json(result)
}
