// app/api/change-requests/[id]/approve-execution/route.ts
// Called when a change is in 'awaiting_approval' state (risk policy = 'approval').
// Approves the plan and fires execution.
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
    .select('id, status, projects!inner(owner_id, repo_url, repo_token)')
    .eq('id', id)
    .eq('projects.owner_id', user.id)
    .single()

  if (!change) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (change.status !== 'awaiting_approval') {
    return NextResponse.json(
      { error: `Change must be in 'awaiting_approval' status, got '${change.status}'` },
      { status: 409 }
    )
  }

  const project = change.projects as unknown as { owner_id: string; repo_url: string | null; repo_token: string | null }
  if (!project.repo_url) {
    return NextResponse.json(
      { error: 'No repository configured', detail: 'Set a repository URL in Project Settings before executing.' },
      { status: 422 }
    )
  }
  if (!project.repo_token) {
    return NextResponse.json(
      { error: 'No access token configured', detail: 'Set a GitHub access token in Project Settings → Repository before executing.' },
      { status: 422 }
    )
  }

  const docker = await checkDocker()
  if (!docker.ok) {
    return NextResponse.json(
      { error: 'Docker is not running', detail: docker.error },
      { status: 503 }
    )
  }

  const adminDb = createAdminClient()

  // Approve the latest plan
  const { data: plan } = await adminDb
    .from('change_plans')
    .select('id')
    .eq('change_id', id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!plan) return NextResponse.json({ error: 'No plan found' }, { status: 404 })

  await adminDb.from('change_plans')
    .update({ status: 'approved', approved_at: new Date().toISOString() })
    .eq('id', plan.id)

  // Set status back to 'planned' so the orchestrator's allowed-status check passes
  await adminDb.from('change_requests').update({ status: 'planned' }).eq('id', id)

  // Clear previous execution history
  await adminDb.from('execution_snapshots').delete().eq('change_id', id)
  await adminDb.from('execution_trace').delete().eq('change_id', id)
  await adminDb.from('execution_logs').delete().eq('change_id', id)

  // Reset plan tasks to pending
  await adminDb.from('change_plan_tasks').update({ status: 'pending' }).eq('plan_id', plan.id)

  const ai = getProvider()
  const executor = new DockerExecutor()

  runExecution(id, adminDb, ai, executor).catch(err =>
    console.error(`[approve-execution] change ${id} failed:`, err)
  )

  return NextResponse.json({ changeId: id, status: 'executing' }, { status: 202 })
}
