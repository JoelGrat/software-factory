import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getProvider } from '@/lib/ai/registry'
import { runImpactAnalysis } from '@/lib/impact/impact-analyzer'
import { validateCreateChangeRequest } from '@/lib/change-requests/validator'

export async function POST(req: Request) {
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
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
    })
    .select('id, project_id, title, intent, type, priority, status, tags, created_at')
    .single()

  if (error || !change) {
    return NextResponse.json({ error: 'Failed to create change request' }, { status: 500 })
  }

  // Auto-trigger impact analysis fire-and-forget
  const adminDb = createAdminClient()
  const ai = getProvider()
  runImpactAnalysis(change.id, adminDb, ai).catch(err =>
    console.error(`[impact-analyzer] change ${change.id} failed:`, err)
  )

  return NextResponse.json(change, { status: 201 })
}
