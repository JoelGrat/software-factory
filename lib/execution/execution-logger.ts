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
    // verbose lines go only to execution_logs (not shown in the live sidebar)
    const emitToEvents = level !== 'verbose' && level !== 'docker'
    const eventType = level === 'success' ? 'log.success' : level === 'error' ? 'log.error' : 'log.info'

    const writes: Promise<unknown>[] = [
      db.from('execution_logs').insert({
        change_id: changeId,
        iteration: getIteration(),
        level,
        message,
      }),
    ]

    if (emitToEvents) {
      writes.push(
        insertEvent(db, {
          runId,
          changeId,
          seq: getSeq(),
          iteration: getIteration(),
          eventType,
          payload: { message },
        }).catch(() => { /* non-fatal */ })
      )
    }

    await Promise.all(writes)
  }
}

export const noopLogger: ExecLogger = async () => {}
