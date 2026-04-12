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

  const { data: change } = await db
    .from('change_requests')
    .select('id, projects!inner(owner_id)')
    .eq('id', id)
    .eq('projects.owner_id', user.id)
    .single()

  if (!change) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const adminDb = createAdminClient()
  const { data: activeRun } = await adminDb
    .from('execution_runs')
    .select('id, status')
    .eq('change_id', id)
    .eq('status', 'running')
    .limit(1)
    .maybeSingle()

  if (!activeRun) {
    return NextResponse.json({ error: 'No active run to cancel' }, { status: 409 })
  }

  const { error: updateError } = await adminDb
    .from('execution_runs')
    .update({ cancellation_requested: true })
    .eq('id', activeRun.id)

  if (updateError) {
    return NextResponse.json({ error: 'Failed to request cancellation' }, { status: 500 })
  }

  return NextResponse.json({ ok: true, runId: activeRun.id })
}
