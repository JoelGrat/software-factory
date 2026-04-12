import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExecutionSummary } from './execution-types-v2'

/** Check for an active run and create a new one atomically. Returns the new run ID, or null if blocked. */
export async function createExecutionRun(
  db: SupabaseClient,
  changeId: string,
): Promise<string | null> {
  // Check for existing running run
  const { data: existing } = await (db.from('execution_runs') as any)
    .select('id')
    .eq('change_id', changeId)
    .eq('status', 'running')
    .limit(1)
    .maybeSingle()

  if (existing) return null  // already running

  const { data, error } = await (db.from('execution_runs') as any)
    .insert({ change_id: changeId, status: 'running' })
    .select('id')
    .single()

  if (error || !data) throw new Error(`Failed to create execution run: ${error?.message}`)
  return data.id as string
}

/** Write heartbeat timestamp every 30s. Returns an interval handle — call clearInterval() on it. */
export function startHeartbeat(db: SupabaseClient, runId: string): ReturnType<typeof setInterval> {
  return setInterval(async () => {
    await (db.from('execution_runs') as any)
      .update({ last_heartbeat_at: new Date().toISOString() })
      .eq('id', runId)
  }, 30_000)
}

/** Check if cancellation was requested for this run. */
export async function isCancellationRequested(db: SupabaseClient, runId: string): Promise<boolean> {
  const { data } = await (db.from('execution_runs') as any)
    .select('cancellation_requested')
    .eq('id', runId)
    .single()
  return (data as any)?.cancellation_requested === true
}

/** Finalize the run: write summary, set status, set ended_at. */
export async function finalizeRun(
  db: SupabaseClient,
  runId: string,
  status: ExecutionSummary['status'],
  summary: ExecutionSummary,
): Promise<void> {
  await (db.from('execution_runs') as any)
    .update({
      status,
      summary,
      ended_at: new Date().toISOString(),
    })
    .eq('id', runId)
}
