import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET() {
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: projects } = await db
    .from('projects')
    .select('id, name, scan_status, created_at')
    .eq('owner_id', user.id)
    .order('created_at', { ascending: false })

  return NextResponse.json(projects ?? [])
}

export async function POST(req: Request) {
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }

  const insert: Record<string, unknown> = {
    name: body.name.trim(),
    owner_id: user.id,
    scan_status: 'pending',
  }
  if (typeof body.repo_url === 'string' && body.repo_url.trim()) {
    insert.repo_url = body.repo_url.trim()
  }
  if (typeof body.repo_token === 'string' && body.repo_token.trim()) {
    insert.repo_token = body.repo_token.trim()
  }

  const { data: project, error } = await db
    .from('projects')
    .insert(insert)
    .select('id, name, scan_status, repo_url, created_at')
    .single()

  if (error || !project) {
    return NextResponse.json({ error: 'Failed to create project' }, { status: 500 })
  }

  return NextResponse.json(project, { status: 201 })
}
