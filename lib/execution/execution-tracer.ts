import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { SymbolContext, FilePatch, ExecutionTraceRow } from './types'

function sha256(str: string): string {
  return createHash('sha256').update(str).digest('hex').slice(0, 16)
}

export function hashInput(ctx: SymbolContext, taskDescription: string): string {
  return sha256(`${ctx.filePath}::${ctx.symbolName}::${ctx.code}::${taskDescription}`)
}

export function hashOutput(patch: FilePatch): string {
  return sha256(patch.newContent)
}

export async function recordTrace(
  db: SupabaseClient,
  row: ExecutionTraceRow
): Promise<void> {
  await db.from('execution_trace').insert({
    change_id:     row.changeId,
    iteration:     row.iteration,
    task_id:       row.taskId,
    context_mode:  row.contextMode,
    input_hash:    row.inputHash,
    output_hash:   row.outputHash,
    strategy_used: row.strategyUsed,
    failure_type:  row.failureType,
    confidence:    row.confidence,
  })
}
