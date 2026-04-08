// app/api/change-requests/[id]/execute/route.ts
import { NextResponse } from 'next/server'
import { exec as execCb } from 'node:child_process'
import { promisify } from 'node:util'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getProvider } from '@/lib/ai/registry'
import { runExecution } from '@/lib/execution/execution-orchestrator'
import { DockerExecutor } from '@/lib/execution/executors/docker-executor'

const exec = promisify(execCb)

async function checkDocker(): Promise<{ ok: boolean; error?: string }> {
  try {
    await exec('docker info', { timeout: 5000 })
    return { ok: true }
  } catch (err) {
    const msg = (err as { stderr?: string; message?: string }).stderr ?? (err as Error).message ?? 'Unknown error'
    return { ok: false, error: msg.split('\n')[0]?.trim() ?? msg }
  }
}

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
    .select('id, status, projects!inner(owner_id, repo_url)')
    .eq('id', id)
    .eq('projects.owner_id', user.id)
    .single()

  if (!change) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const project = change.projects as unknown as { owner_id: string; repo_url: string | null }
  if (!project.repo_url) {
    return NextResponse.json(
      { error: 'No repository configured', detail: 'Set a repository URL in Project Settings before executing.' },
      { status: 422 }
    )
  }

  if (!['planned', 'failed'].includes(change.status)) {
    return NextResponse.json(
      { error: `Cannot execute from status '${change.status}'. Change must be 'planned' or 'failed'.` },
      { status: 409 }
    )
  }

  // Verify approved plan exists
  const { data: plan } = await db
    .from('change_plans')
    .select('id, status')
    .eq('change_id', id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!plan || plan.status !== 'approved') {
    return NextResponse.json({ error: 'No approved plan found' }, { status: 409 })
  }

  const docker = await checkDocker()
  if (!docker.ok) {
    return NextResponse.json(
      { error: 'Docker is not running', detail: docker.error },
      { status: 503 }
    )
  }

  const adminDb = createAdminClient()
  const ai = getProvider()
  const executor = new DockerExecutor()

  runExecution(id, adminDb, ai, executor).catch(err =>
    console.error(`[execution-orchestrator] change ${id} failed:`, err)
  )

  return NextResponse.json({ changeId: id, status: 'executing' }, { status: 202 })
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
    .select('id, status, projects!inner(owner_id)')
    .eq('id', id)
    .eq('projects.owner_id', user.id)
    .single()

  if (!change) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: snapshots } = await db
    .from('execution_snapshots')
    .select('id, iteration, files_modified, tests_passed, tests_failed, error_summary, termination_reason, planned_files, propagated_files, plan_divergence, partial_success, duration_ms')
    .eq('change_id', id)
    .order('iteration', { ascending: true })

  const { data: traces } = await db
    .from('execution_trace')
    .select('id, iteration, task_id, context_mode, failure_type, confidence, created_at')
    .eq('change_id', id)
    .order('created_at', { ascending: true })

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
        .select('id, description, status, failure_type, last_error, order_index, system_components(name, type)')
        .eq('plan_id', latestPlan.id)
        .order('order_index', { ascending: true })
    : { data: [] }

  return NextResponse.json({
    status: change.status,
    snapshots: snapshots ?? [],
    traces: traces ?? [],
    tasks: tasks ?? [],
  })
}
