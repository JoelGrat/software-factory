import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getProvider } from '@/lib/ai/registry'
import { generateSpec } from '@/lib/planning/spec-generator'
import { createSpec } from '@/lib/planning/planning-repository'

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: change } = await db
    .from('change_requests')
    .select('id, projects!inner(owner_id)')
    .eq('id', id)
    .eq('projects.owner_id', user.id)
    .single()

  if (!change) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const ai = getProvider()
  const { spec, markdown } = await generateSpec(id, db, ai)

  await createSpec(db, id, spec, markdown)

  return NextResponse.json({ spec_markdown: markdown })
}
