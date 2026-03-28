import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { generateVisionRequirements } from '@/lib/agent/vision-generator'
import type { ProjectVision } from '@/lib/supabase/types'

type Params = { params: Promise<{ id: string }> }

export async function POST(_req: Request, { params }: Params) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Verify project ownership
  const { data: project } = await db
    .from('projects').select('id').eq('id', id).eq('owner_id', user.id).single()
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Load vision
  const { data: vision } = await db
    .from('project_visions').select('*').eq('project_id', id).single()
  if (!vision) return NextResponse.json({ error: 'No vision found' }, { status: 400 })

  // Validate content
  const hasContent = vision.mode === 'free_form'
    ? vision.free_form_text.trim().length > 0
    : vision.goal.trim().length > 0 || vision.key_features.trim().length > 0
  if (!hasContent) return NextResponse.json({ error: 'Vision has no content' }, { status: 400 })

  // Guard: already generating
  if (vision.status === 'generating') {
    return NextResponse.json({ error: 'Already generating' }, { status: 409 })
  }

  // Get requirement id
  const { data: req_ } = await db
    .from('requirements').select('id').eq('project_id', id).single()
  if (!req_) return NextResponse.json({ error: 'Requirements row missing' }, { status: 500 })

  // If retrying, clear existing items
  if (vision.status === 'failed' || vision.status === 'done') {
    await db.from('requirement_items').delete().eq('requirement_id', req_.id)
  }

  // Set status to generating
  await db.from('project_visions')
    .update({ status: 'generating', error: null, updated_at: new Date().toISOString() })
    .eq('project_id', id)

  // Fire and forget — Next.js 14 Node.js runtime keeps process alive
  void generateVisionRequirements(id, vision as ProjectVision, req_.id)

  return NextResponse.json({ ok: true }, { status: 202 })
}
