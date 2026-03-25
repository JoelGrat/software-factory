import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET() {
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: projects } = await db
    .from('projects')
    .select('id, name, created_at')
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

  const { data: project, error } = await db
    .from('projects')
    .insert({ name: body.name.trim(), owner_id: user.id })
    .select('id, name, created_at')
    .single()

  if (error) return NextResponse.json({ error: 'Failed to create project' }, { status: 500 })
  return NextResponse.json(project, { status: 201 })
}
