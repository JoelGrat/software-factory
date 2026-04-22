// app/api/projects/[id]/env-vars/route.ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { encrypt } from '@/lib/preview/crypto'

type Params = { params: Promise<{ id: string }> }

/** GET — return keys only (never values) */
export async function GET(_req: Request, { params }: Params) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: project } = await db.from('projects').select('id').eq('id', id).eq('owner_id', user.id).single()
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const admin = createAdminClient()
  const { data } = await (admin.from('project_env_vars') as any)
    .select('id, key, updated_at')
    .eq('project_id', id)
    .order('key')

  return NextResponse.json(data ?? [])
}

/** POST — upsert a single key/value */
export async function POST(req: Request, { params }: Params) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: project } = await db.from('projects').select('id').eq('id', id).eq('owner_id', user.id).single()
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await req.json()
  const key: string = body.key?.trim()
  const value: string = body.value

  if (!key || typeof value !== 'string') {
    return NextResponse.json({ error: 'key and value are required' }, { status: 400 })
  }

  let value_enc: string
  try {
    value_enc = encrypt(value)
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }

  const admin = createAdminClient()
  const { error } = await (admin.from('project_env_vars') as any)
    .upsert({ project_id: id, key, value_enc, updated_at: new Date().toISOString() }, { onConflict: 'project_id,key' })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

/** DELETE — remove a single key */
export async function DELETE(req: Request, { params }: Params) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: project } = await db.from('projects').select('id').eq('id', id).eq('owner_id', user.id).single()
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { key } = await req.json()
  if (!key) return NextResponse.json({ error: 'key required' }, { status: 400 })

  const admin = createAdminClient()
  const { error } = await (admin.from('project_env_vars') as any).delete().eq('project_id', id).eq('key', key)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
