// app/api/projects/[id]/preview-config/route.ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

type Params = { params: Promise<{ id: string }> }

const DEFAULTS = {
  install_command: 'auto', start_command: 'auto', work_dir: '.',
  health_path: '/', health_text: null, port_internal: 3000,
  expected_keys: [], max_memory_mb: 1024, max_cpu_shares: 512,
}

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: project } = await db.from('projects').select('id').eq('id', id).eq('owner_id', user.id).single()
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const admin = createAdminClient()
  const { data } = await (admin.from('project_preview_config') as any)
    .select('*')
    .eq('project_id', id)
    .maybeSingle()

  return NextResponse.json(data ?? { ...DEFAULTS, project_id: id })
}

export async function PUT(req: Request, { params }: Params) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: project } = await db.from('projects').select('id').eq('id', id).eq('owner_id', user.id).single()
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await req.json()
  const payload = {
    project_id: id,
    install_command: body.install_command ?? DEFAULTS.install_command,
    start_command: body.start_command ?? DEFAULTS.start_command,
    work_dir: body.work_dir ?? DEFAULTS.work_dir,
    health_path: body.health_path ?? DEFAULTS.health_path,
    health_text: body.health_text ?? null,
    port_internal: body.port_internal ?? DEFAULTS.port_internal,
    expected_keys: Array.isArray(body.expected_keys) ? body.expected_keys : DEFAULTS.expected_keys,
    max_memory_mb: body.max_memory_mb ?? DEFAULTS.max_memory_mb,
    max_cpu_shares: body.max_cpu_shares ?? DEFAULTS.max_cpu_shares,
    updated_at: new Date().toISOString(),
  }

  const admin = createAdminClient()
  const { error } = await (admin.from('project_preview_config') as any)
    .upsert(payload, { onConflict: 'project_id' })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
