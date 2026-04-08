// app/api/change-requests/[id]/approve/route.ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

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
    .select('id, status, projects!inner(owner_id)')
    .eq('id', id)
    .eq('projects.owner_id', user.id)
    .single()

  if (!change) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  if (change.status !== 'review') {
    return NextResponse.json({ error: 'Change must be in review status to approve' }, { status: 409 })
  }

  const { error } = await db
    .from('change_requests')
    .update({ status: 'done', updated_at: new Date().toISOString() })
    .eq('id', id)

  if (error) return NextResponse.json({ error: 'Update failed' }, { status: 500 })

  // Best-effort: record outcome for risk calibration
  void Promise.resolve(
    db.from('risk_predictions')
      .update({ outcome: 'approved', resolved_at: new Date().toISOString() })
      .eq('change_id', id)
      .is('outcome', null)
  ).catch(() => { /* non-fatal */ })

  return NextResponse.json({ status: 'done' })
}
