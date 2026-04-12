import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Verify ownership
  const { data: change } = await db
    .from('change_requests')
    .select('id, projects!inner(owner_id)')
    .eq('id', id)
    .eq('projects.owner_id', user.id)
    .single()

  if (!change) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const adminDb = createAdminClient()
  const { error } = await adminDb.from('change_requests').delete().eq('id', id)
  if (error) return NextResponse.json({ error: 'Delete failed' }, { status: 500 })

  return NextResponse.json({ ok: true })
}
