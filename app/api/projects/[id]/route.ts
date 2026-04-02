import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: project } = await db
    .from('projects')
    .select('id, name, owner_id, repo_url, scan_status, scan_error, scan_progress, lock_version, created_at')
    .eq('id', id)
    .eq('owner_id', user.id)
    .single()

  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Live counts for dashboard
  const [{ count: fileCount }, { count: componentCount }, { count: edgeCount }, { data: topComponents }] =
    await Promise.all([
      db.from('files').select('*', { count: 'exact', head: true }).eq('project_id', id),
      db.from('system_components').select('*', { count: 'exact', head: true }).eq('project_id', id).is('deleted_at', null),
      db.from('component_graph_edges').select('*', { count: 'exact', head: true }).eq('project_id', id),
      db.from('system_components')
        .select('id, name, type, status, is_anchored, scan_count')
        .eq('project_id', id)
        .is('deleted_at', null)
        .order('scan_count', { ascending: false })
        .limit(12),
    ])

  // Unknown deps: components whose files have low-confidence assignments
  const { count: lowConfCount } = await db
    .from('component_assignment')
    .select('*', { count: 'exact', head: true })
    .lt('confidence', 60)
    .in('component_id', (topComponents ?? []).map(c => c.id))

  return NextResponse.json({
    ...project,
    stats: {
      fileCount: fileCount ?? 0,
      componentCount: componentCount ?? 0,
      edgeCount: edgeCount ?? 0,
      lowConfidenceCount: lowConfCount ?? 0,
    },
    topComponents: topComponents ?? [],
  })
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const updates: Record<string, unknown> = {}
  if (typeof body.repo_url === 'string') updates.repo_url = body.repo_url.trim() || null
  if (typeof body.repo_token === 'string') updates.repo_token = body.repo_token.trim() || null
  if (typeof body.name === 'string' && body.name.trim()) updates.name = body.name.trim()

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }

  const { data, error } = await db
    .from('projects')
    .update(updates)
    .eq('id', id)
    .eq('owner_id', user.id)
    .select('id, name, repo_url, scan_status, lock_version')
    .single()

  if (error || !data) return NextResponse.json({ error: 'Update failed' }, { status: 500 })
  return NextResponse.json(data)
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { error } = await db
    .from('projects')
    .delete()
    .eq('id', id)
    .eq('owner_id', user.id)

  if (error) return NextResponse.json({ error: 'Delete failed' }, { status: 500 })
  return new NextResponse(null, { status: 204 })
}
