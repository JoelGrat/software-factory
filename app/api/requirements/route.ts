import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function POST(req: Request) {
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  if (!body.project_id || typeof body.project_id !== 'string') {
    return NextResponse.json({ error: 'project_id is required' }, { status: 400 })
  }

  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'Requirements'

  const { data: req_, error } = await db
    .from('requirements')
    .insert({
      project_id: body.project_id,
      title,
      raw_input: '',
      status: 'draft',
    })
    .select('id, project_id, title, raw_input, status, created_at, updated_at')
    .single()

  if (error) return NextResponse.json({ error: 'Failed to create requirement' }, { status: 500 })
  return NextResponse.json(req_, { status: 201 })
}
