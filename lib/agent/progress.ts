import type { SupabaseClient } from '@supabase/supabase-js'
import type { LogPhase, LogLevel } from '@/lib/supabase/types'

export async function logProgress(
  db: SupabaseClient,
  jobId: string,
  phase: LogPhase,
  message: string,
  level: LogLevel = 'info'
): Promise<void> {
  try {
    await db.from('job_logs').insert({ job_id: jobId, phase, level, message })
  } catch {
    // logging must never abort the job
  }
}
