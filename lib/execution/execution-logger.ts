// lib/execution/execution-logger.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExecLogger } from './types'
import { insertEvent } from './event-emitter'

export function makeLogger(
  db: SupabaseClient,
  changeId: string,
  runId: string,
  getIteration: () => number,
  getSeq: () => number,
): ExecLogger {
  return async (level, message) => {
    const eventType = level === 'success' ? 'log.success' : level === 'error' ? 'log.error' : 'log.info'
    await Promise.all([
      // execution_logs kept for backward compat (GET /execute handler, approve-execution cleanup)
      db.from('execution_logs').insert({
        change_id: changeId,
        iteration: getIteration(),
        level,
        message,
      }),
      // execution_events feeds the live log sidebar in the execution view
      insertEvent(db, {
        runId,
        changeId,
        seq: getSeq(),
        iteration: getIteration(),
        eventType,
        payload: { message },
      }).catch(() => { /* non-fatal — structured events are best-effort */ }),
    ])
  }
}

export const noopLogger: ExecLogger = async () => {}
