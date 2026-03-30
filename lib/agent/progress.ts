import type { SupabaseClient } from '@supabase/supabase-js'
// TODO: replaced in Plan 2/3/4 — old types removed in migration 006
/* eslint-disable @typescript-eslint/no-explicit-any */
// import type { LogPhase, LogLevel } from '@/lib/supabase/types' // removed in migration 006

export async function logProgress(
  db: SupabaseClient,
  jobId: string,
  phase: any,
  message: string,
  level: any = 'info'
): Promise<void> {
  try {
    await db.from('job_logs').insert({ job_id: jobId, phase, level, message })
  } catch {
    // logging must never abort the job
  }
}
