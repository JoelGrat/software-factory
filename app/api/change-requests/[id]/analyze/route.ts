import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getProvider } from '@/lib/ai/registry'
import { runImpactAnalysisPhase } from '@/lib/pipeline/phases/impact-analysis'

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Verify ownership via project
  const { data: change } = await db
    .from('change_requests')
    .select('id, status, projects!inner(owner_id)')
    .eq('id', id)
    .eq('projects.owner_id', user.id)
    .single()

  if (!change) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Prevent re-triggering an in-progress analysis
  const ANALYZING = ['analyzing', 'analyzing_mapping', 'analyzing_propagation', 'analyzing_scoring']
  if (ANALYZING.includes(change.status)) {
    return NextResponse.json({ error: 'Analysis already in progress' }, { status: 409 })
  }

  // Reset to draft_planned so the phase precondition check passes
  const adminDb = createAdminClient()
  await adminDb.from('change_requests')
    .update({ pipeline_status: 'draft_planned' })
    .eq('id', id)

  const ai = getProvider()
  runImpactAnalysisPhase(id, adminDb, ai).catch(err =>
    console.error(`[impact-analysis-phase] change ${id} failed:`, err)
  )

  return NextResponse.json({ status: 'analyzing' }, { status: 202 })
}
