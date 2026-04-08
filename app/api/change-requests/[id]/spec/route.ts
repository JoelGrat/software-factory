import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getProvider } from '@/lib/ai/registry'
import { runSpecPhase } from '@/lib/planning/phases'

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
    .select('id, title, intent, type, projects!inner(owner_id)')
    .eq('id', id)
    .eq('projects.owner_id', user.id)
    .single()

  if (!change) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: plan } = await db
    .from('change_plans')
    .select('id, estimated_files')
    .eq('change_id', id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!plan) return NextResponse.json({ error: 'No plan found' }, { status: 404 })

  const { data: rawTasks } = await db
    .from('change_plan_tasks')
    .select('description, order_index, system_components(name, type)')
    .eq('plan_id', plan.id)
    .order('order_index', { ascending: true })

  const tasks = (rawTasks ?? []).map((t: any) => ({
    description: t.description,
    componentId: '',
    componentName: t.system_components?.name ?? 'General',
    orderIndex: t.order_index,
  }))

  const ai = getProvider()
  const specMarkdown = await runSpecPhase(
    { title: change.title, intent: change.intent, type: change.type },
    { approach: '', branchName: '', testApproach: '', estimatedFiles: plan.estimated_files ?? 0, componentApproaches: {} },
    tasks,
    ai
  )

  if (!specMarkdown) return NextResponse.json({ error: 'Spec generation failed' }, { status: 500 })

  await db.from('change_plans').update({ spec_markdown: specMarkdown }).eq('id', plan.id)

  return NextResponse.json({ spec_markdown: specMarkdown })
}
