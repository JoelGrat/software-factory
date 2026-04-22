// app/api/change-requests/[id]/preview/keepalive/route.ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { touchActivity, expireIdle } from '@/lib/preview/preview-manager'

type Params = { params: Promise<{ id: string }> }

export async function POST(req: Request, { params }: Params) {
  const { id: changeId } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: change } = await db
    .from('change_requests')
    .select('id, project_id, projects!inner(owner_id)')
    .eq('id', changeId)
    .eq('projects.owner_id', user.id)
    .single()
  if (!change) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const body = await req.json().catch(() => ({}))
  const { previewId } = body
  if (!previewId) return NextResponse.json({ error: 'previewId required' }, { status: 400 })

  const admin = createAdminClient()
  await expireIdle(admin, change.project_id)
  await touchActivity(admin, previewId)
  return NextResponse.json({ ok: true })
}
