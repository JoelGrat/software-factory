// app/api/internal/execution-recovery/route.ts
// Called by a Supabase cron or on-startup hook to reap immortal "running" runs.
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'

export async function POST(req: Request) {
  // Simple shared secret guard — not user-auth, this is internal
  const secret = req.headers.get('x-internal-secret')
  if (secret !== process.env.INTERNAL_API_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!process.env.INTERNAL_API_SECRET) {
    console.error('[reaper] INTERNAL_API_SECRET is not set — reaper is disabled')
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 })
  }

  const db = createAdminClient()

  // Find stale runs: running for >15min with heartbeat >2min old
  const { data: staleRuns, error: queryError } = await db
    .from('execution_runs')
    .select('id, change_id')
    .eq('status', 'running')
    .lt('started_at', new Date(Date.now() - 15 * 60 * 1000).toISOString())
    .or(`last_heartbeat_at.is.null,last_heartbeat_at.lt.${new Date(Date.now() - 2 * 60 * 1000).toISOString()}`)

  if (queryError) {
    console.error('[reaper] stale-run query failed:', queryError)
    return NextResponse.json({ error: 'DB error' }, { status: 500 })
  }

  const reaped: string[] = []
  for (const run of staleRuns ?? []) {
    const summary = {
      status: 'blocked',
      iterationsUsed: 0,
      repairsAttempted: 0,
      filesChanged: [],
      finalFailureType: 'server_interrupted',
      commitOutcome: { type: 'no_commit', reason: 'server interrupted' },
      durationMs: 0,
    }
    const { error: updateError } = await db
      .from('execution_runs')
      .update({
        status: 'blocked',
        summary,
        ended_at: new Date().toISOString(),
      }).eq('id', run.id)

    if (updateError) {
      console.error(`[reaper] failed to update run ${run.id}:`, updateError)
      continue
    }

    const { error: insertError } = await db
      .from('execution_events')
      .insert({
        run_id: run.id,
        change_id: run.change_id,
        seq: 9999,
        iteration: 0,
        event_type: 'execution.blocked',
        schema_version: 1,
        payload: { reason: 'server_interrupted' },
      })

    if (insertError) {
      console.error(`[reaper] failed to insert blocked event for run ${run.id}:`, insertError)
    }

    reaped.push(run.id)
  }

  return NextResponse.json({ reaped, count: reaped.length })
}
