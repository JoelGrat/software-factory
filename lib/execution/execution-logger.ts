// lib/execution/execution-logger.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExecLogger } from './types'

export function makeLogger(
  db: SupabaseClient,
  changeId: string,
  getIteration: () => number
): ExecLogger {
  return async (level, message) => {
    await db.from('execution_logs').insert({
      change_id: changeId,
      iteration: getIteration(),
      level,
      message,
    })
  }
}

export const noopLogger: ExecLogger = async () => {}
