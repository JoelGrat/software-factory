import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getProvider } from '@/lib/ai/registry'
import { LocalExecutor } from '@/lib/agent/executor'
import { runJob } from '@/lib/agent/job-runner'

export async function POST(req: Request) {
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  if (!body.requirement_id || typeof body.requirement_id !== 'string') {
    return NextResponse.json({ error: 'requirement_id is required' }, { status: 400 })
  }

  const { data: req_ } = await db
    .from('requirements')
    .select('id, project_id, status')
    .eq('id', body.requirement_id)
    .single()

  if (!req_) return NextResponse.json({ error: 'Requirement not found' }, { status: 404 })
  if (req_.status !== 'ready_for_dev') {
    return NextResponse.json({ error: 'Requirement must be ready_for_dev to run agent' }, { status: 422 })
  }

  const { data: project } = await db
    .from('projects')
    .select('id, target_path')
    .eq('id', req_.project_id)
    .eq('owner_id', user.id)
    .single()

  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  const { data: job, error } = await db
    .from('jobs')
    .insert({ project_id: req_.project_id, requirement_id: body.requirement_id, status: 'pending' })
    .select('*')
    .single()

  if (error || !job) return NextResponse.json({ error: 'Failed to create job' }, { status: 500 })

  // Kick off async — does not block response
  const adminDb = createAdminClient()
  const ai = getProvider()
  const executor = new LocalExecutor()
  void runJob(job.id, 'planning', adminDb, ai, executor)

  return NextResponse.json(job, { status: 201 })
}
