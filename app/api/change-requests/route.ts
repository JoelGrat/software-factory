import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getProvider } from '@/lib/ai/registry'
import { runPipeline } from '@/lib/pipeline/orchestrator'
import { validateCreateChangeRequest, runContentValidation } from '@/lib/change-requests/validator'

export async function POST(req: Request) {
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const clientRequestId = req.headers.get('X-Client-Request-Id')
  const validation = validateCreateChangeRequest(body)
  if (!validation.valid) return NextResponse.json({ error: validation.error }, { status: 400 })

  if (!body.project_id || typeof body.project_id !== 'string') {
    return NextResponse.json({ error: 'project_id is required' }, { status: 400 })
  }

  // Verify project ownership
  const { data: project } = await db
    .from('projects')
    .select('id')
    .eq('id', body.project_id)
    .eq('owner_id', user.id)
    .single()

  if (!project) return NextResponse.json({ error: 'Project not found' }, { status: 404 })

  // Stage 2 AI validation (suspicion-gated — runContentValidation skips AI internally if flags < 2)
  const ai = getProvider()
  const contentCheck = await runContentValidation(
    validation.data.title,
    validation.data.intent,
    validation.data.type,
    ai
  )
  if (!contentCheck.valid) {
    return NextResponse.json(contentCheck, { status: 400 })
  }

  const { data: change, error } = await db
    .from('change_requests')
    .insert({
      project_id: body.project_id,
      title: validation.data.title,
      intent: validation.data.intent,
      type: validation.data.type,
      priority: validation.data.priority,
      tags: validation.data.tags,
      status: 'open',
      triggered_by: 'user',
      created_by: user.id,
      client_request_id: clientRequestId ?? undefined,
    })
    .select('id, project_id, title, intent, type, priority, status, tags, created_at')
    .single()

  if (error || !change) {
    return NextResponse.json({ error: 'Failed to create change request' }, { status: 500 })
  }

  // Clear any pinned baseline_blocked suggestion for this project — the user
  // has acknowledged it by creating a change.
  const adminDb = createAdminClient()
  await adminDb.from('action_items')
    .delete()
    .eq('project_id', body.project_id)
    .eq('source', 'baseline_blocked')

  // Set pipeline_status before firing async pipeline
  await adminDb.from('change_requests')
    .update({ pipeline_status: 'validated' })
    .eq('id', change.id)

  // Fire-and-forget full pipeline (adminDb2 to avoid reuse after possible timeout)
  const adminDb2 = createAdminClient()
  runPipeline(change.id, adminDb2, ai).catch(err =>
    console.error(`[pipeline] change ${change.id} failed:`, err)
  )

  return NextResponse.json(change, { status: 201 })
}
