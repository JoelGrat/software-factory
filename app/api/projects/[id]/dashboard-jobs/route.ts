import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { runDashboardJobs } from '@/lib/dashboard/jobs/runner'

// Called internally from execute route and externally from a cron job.
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params
  const adminDb = createAdminClient()

  // Fire and forget — return 202 immediately
  runDashboardJobs(adminDb, projectId).catch(err =>
    console.error('[dashboard-jobs] runner failed:', err)
  )

  return NextResponse.json({ status: 'running' }, { status: 202 })
}
