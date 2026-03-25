import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: req } = await db
    .from('requirements')
    .select('id, project_id, title, raw_input, status, blocked_reason, created_at, updated_at')
    .eq('id', id)
    .single()

  if (!req) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Verify ownership via project
  const { data: project } = await db
    .from('projects')
    .select('id')
    .eq('id', req.project_id)
    .eq('owner_id', user.id)
    .single()

  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json(req)
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  if (typeof body.raw_input !== 'string') {
    return NextResponse.json({ error: 'raw_input is required' }, { status: 400 })
  }

  // Verify ownership before updating
  const { data: existing } = await db
    .from('requirements')
    .select('project_id')
    .eq('id', id)
    .single()

  if (!existing) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: project } = await db
    .from('projects')
    .select('id')
    .eq('id', existing.project_id)
    .eq('owner_id', user.id)
    .single()

  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { error } = await db
    .from('requirements')
    .update({ raw_input: body.raw_input, updated_at: new Date().toISOString() })
    .eq('id', id)

  if (error) return NextResponse.json({ error: 'Failed to update' }, { status: 500 })
  return NextResponse.json({ ok: true })
}
