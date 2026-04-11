// app/api/projects/[id]/dashboard-poll/route.ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params
  const db = createClient()
  const { data: { user } } = await db.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: project } = await db
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('owner_id', user.id)
    .single()
  if (!project) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  // Return current state for all active changes in the project
  const { data: activeChanges, error: acError } = await db
    .from('change_requests')
    .select('id, status, analysis_status, pipeline_status, analysis_version, updated_at')
    .eq('project_id', projectId)
    .not('analysis_status', 'in', '("completed","stalled")')
    .order('updated_at', { ascending: false })

  if (acError) {
    console.error('[dashboard-poll] active changes query failed', { projectId, error: acError })
    return NextResponse.json({ error: 'Query failed' }, { status: 500 })
  }

  // Return latest snapshots for recently-completed changes (last 5)
  // Guard against empty activeChanges to avoid sending empty .in([])
  const snapshots = (activeChanges ?? []).length === 0
    ? []
    : await db
        .from('analysis_result_snapshot')
        .select('change_id, execution_outcome, snapshot_status, minimal, analysis_status, completed_at')
        .in('change_id', activeChanges!.map((c) => c.id))
        .then(({ data, error }) => {
          if (error) {
            console.error('[dashboard-poll] snapshots query failed', { projectId, error })
            return null
          }
          return data ?? []
        })

  if (snapshots === null) {
    return NextResponse.json({ error: 'Query failed' }, { status: 500 })
  }

  return NextResponse.json({
    activeChanges: activeChanges ?? [],
    snapshots,
    polledAt: new Date().toISOString(),
  })
}
