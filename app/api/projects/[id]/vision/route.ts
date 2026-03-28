import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

type Params = { params: Promise<{ id: string }> }

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Verify ownership
  const { data: project } = await db
    .from('projects').select('id').eq('id', id).eq('owner_id', user.id).single()
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Upsert draft vision row
  await db
    .from('project_visions')
    .upsert({ project_id: id }, { onConflict: 'project_id', ignoreDuplicates: true })

  const { data: vision, error } = await db
    .from('project_visions')
    .select('*')
    .eq('project_id', id)
    .single()

  if (error || !vision) return NextResponse.json({ error: 'DB error' }, { status: 500 })

  return NextResponse.json(vision)
}

export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: project } = await db
    .from('projects').select('id').eq('id', id).eq('owner_id', user.id).single()
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await req.json()
  const allowed = ['mode', 'free_form_text', 'goal', 'tech_stack', 'target_users', 'key_features', 'constraints']
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  for (const key of allowed) {
    if (key in body) updates[key] = body[key]
  }

  const { data, error } = await db
    .from('project_visions')
    .update(updates)
    .eq('project_id', id)
    .select()
    .single()

  if (error || !data) return NextResponse.json({ error: 'Update failed' }, { status: 500 })
  return NextResponse.json(data)
}
