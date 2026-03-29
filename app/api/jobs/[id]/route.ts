import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getProvider } from '@/lib/ai/registry'
import { LocalExecutor } from '@/lib/agent/executor'
import { runJob } from '@/lib/agent/job-runner'
import { validateUpdateTasks } from '@/lib/agent/update-tasks-validator'

async function getJobAndVerifyOwner(jobId: string, userId: string) {
  const db = createClient()
  const { data: job } = await db.from('jobs').select('*, projects!inner(owner_id)').eq('id', jobId).single()
  if (!job) return null
  if ((job.projects as { owner_id: string }).owner_id !== userId) return null
  return job
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const job = await getJobAndVerifyOwner(id, user.id)
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const [{ data: plan }, { data: logs }] = await Promise.all([
    db.from('agent_plans').select('*').eq('job_id', id).maybeSingle(),
    db.from('job_logs').select('*').eq('job_id', id).order('created_at', { ascending: true }),
  ])

  return NextResponse.json({ job, plan, logs: logs ?? [] })
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const job = await getJobAndVerifyOwner(id, user.id)
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await req.json()
  const action = body.action as string

  const adminDb = createAdminClient()
  const ai = getProvider()
  const executor = new LocalExecutor()

  if (action === 'approve_plan') {
    if (job.status !== 'awaiting_plan_approval') {
      return NextResponse.json({ error: 'Job is not awaiting plan approval' }, { status: 422 })
    }
    await db.from('jobs').update({ status: 'coding' }).eq('id', id)
    void runJob(id, 'coding', adminDb, ai, executor)
    return NextResponse.json({ ok: true })
  }

  if (action === 'approve_review') {
    if (job.status !== 'awaiting_review') {
      return NextResponse.json({ error: 'Job is not awaiting review' }, { status: 422 })
    }
    await db.from('jobs').update({ status: 'done', completed_at: new Date().toISOString() }).eq('id', id)
    return NextResponse.json({ ok: true })
  }

  if (action === 'retry') {
    if (job.status !== 'awaiting_review' && job.status !== 'failed') {
      return NextResponse.json({ error: 'Job cannot be retried in current status' }, { status: 422 })
    }
    await db.from('jobs').update({ status: 'coding', error: null }).eq('id', id)
    void runJob(id, 'coding', adminDb, ai, executor)
    return NextResponse.json({ ok: true })
  }

  if (action === 'cancel') {
    await db.from('jobs').update({ status: 'cancelled', completed_at: new Date().toISOString() }).eq('id', id)
    return NextResponse.json({ ok: true })
  }

  if (action === 'update_tasks') {
    if (job.status !== 'awaiting_plan_approval') {
      return NextResponse.json({ error: 'Job is not awaiting plan approval' }, { status: 422 })
    }
    const validation = validateUpdateTasks(body.tasks)
    if (!validation.valid) {
      return NextResponse.json({ error: validation.error }, { status: 400 })
    }
    await db.from('agent_plans').update({ tasks: body.tasks }).eq('job_id', id)
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const job = await getJobAndVerifyOwner(id, user.id)
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await db.from('jobs').update({ status: 'cancelled', completed_at: new Date().toISOString() }).eq('id', id)
  return NextResponse.json({ ok: true })
}
