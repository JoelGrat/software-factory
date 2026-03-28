import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: items } = await db
    .from('requirement_items')
    .select('*')
    .eq('requirement_id', id)
    .order('created_at', { ascending: true })

  return NextResponse.json(items ?? [])
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Verify ownership via project
  const { data: requirement } = await db
    .from('requirements')
    .select('project_id')
    .eq('id', id)
    .single()
  if (!requirement) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const { data: project } = await db
    .from('projects')
    .select('id')
    .eq('id', requirement.project_id)
    .eq('owner_id', user.id)
    .single()
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await req.json()
  const { type, title, description, priority } = body

  const VALID_TYPES = ['functional', 'non-functional', 'constraint', 'assumption']
  const VALID_PRIORITIES = ['high', 'medium', 'low']

  if (!VALID_TYPES.includes(type)) return NextResponse.json({ error: 'Invalid type' }, { status: 400 })
  if (!title?.trim()) return NextResponse.json({ error: 'title is required' }, { status: 400 })
  if (!description?.trim()) return NextResponse.json({ error: 'description is required' }, { status: 400 })
  if (!VALID_PRIORITIES.includes(priority)) return NextResponse.json({ error: 'Invalid priority' }, { status: 400 })

  const { data: item, error } = await db
    .from('requirement_items')
    .insert({
      requirement_id: id,
      type,
      title: title.trim(),
      description: description.trim(),
      priority,
      source_text: null,
      nfr_category: null,
    })
    .select('*')
    .single()

  if (error || !item) return NextResponse.json({ error: 'Failed to create item' }, { status: 500 })
  return NextResponse.json(item, { status: 201 })
}
